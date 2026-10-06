/**
 * A small network for the SSH and SSL integration test, in Docker:
 *
 *   PPM ──▶ bastion ──▶ sshd ──▶ pg, mariadb
 *
 * The databases' names resolve only inside Docker, on a network they share with `sshd`, so a test
 * that reaches them by `pg` or `mariadb` can only have gone through the tunnel. Both SSH servers
 * are OpenSSH (`fixtures/sshd`), published on 127.0.0.1 only. Postgres and MariaDB serve
 * certificates signed by a CA made here, naming them by DNS and by their address on that network;
 * Postgres sends its chain, as a real server with an intermediate would. Both databases also have
 * an address their certificates do not name, on the SSH servers' own network, and are published
 * on 127.0.0.1 — which their certificates do not name either.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";

export const SSHD_IMAGE = "ppm-test-sshd:1";
export const PG_PASSWORD = "pgsecret1";
export const MARIADB_PASSWORD = "mariasecret1";
export const KEY_PASSPHRASE = "kp-secret";

export interface Lab {
  /** `sshd` and the bastion, as the PPM host reaches them. */
  sshPort: number;
  bastionPort: number;
  /** The databases published on 127.0.0.1, for connections and checks made around the tunnel. */
  pgPort: number;
  mariadbPort: number;
  /** `sshd` on the databases' network: the address their sessions through the tunnel come from. */
  sshdIp: string;
  pgIp: string;
  mariadbIp: string;
  /** Addresses `sshd` also reaches the databases at, which their certificates do not name. */
  pgOtherIp: string;
  mariadbOtherIp: string;
  /** The CA that signed both servers' certificates. */
  ca: string;
  /** alice's ed25519 keys: one plain, one behind `KEY_PASSPHRASE`. */
  key: string;
  keyWithPassphrase: string;
  /** Postgres as its superuser, from the PPM host. */
  pgAdmin: postgres.Sql;
  /** A new host key for `sshd`, as a reinstalled server would have. */
  rekeySshd(): Promise<void>;
  close(): Promise<void>;
}

async function run(args: string[], stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(args, { stdin: stdin === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
  if (stdin !== undefined) {
    proc.stdin!.write(stdin);
    await proc.stdin!.end();
  }
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

async function must(args: string[], stdin?: string): Promise<string> {
  const r = await run(args, stdin);
  if (r.code !== 0) throw new Error(`${args.join(" ")} failed (${r.code}): ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

/** Whether this machine can run the lab at all. */
export async function dockerAvailable(): Promise<boolean> {
  try {
    return (await run(["docker", "info", "--format", "{{.ServerVersion}}"])).code === 0;
  } catch {
    return false;
  }
}

async function addressOn(container: string, network: string): Promise<string> {
  const ip = await must(["docker", "inspect", "-f", `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, container]);
  if (!ip) throw new Error(`${container} has no address on ${network}`);
  return ip;
}

async function publishedPort(container: string, port: number): Promise<number> {
  const out = await must(["docker", "port", container, `${port}/tcp`]);
  const line = out.split("\n").find((l) => l.startsWith("127.0.0.1:"));
  if (!line) throw new Error(`${container} does not publish ${port} on 127.0.0.1: ${out}`);
  return Number(line.slice(line.lastIndexOf(":") + 1));
}

/** Resolves once something on `port` says `SSH-2.0`, as OpenSSH does when it is ready. */
async function waitForSsh(port: number, timeoutMs = 30_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const banner = await new Promise<string>((resolve) => {
      const sock = net.connect(port, "127.0.0.1");
      let got = "";
      const done = () => { sock.destroy(); resolve(got); };
      sock.setTimeout(1000, done);
      sock.on("data", (d) => { got += d.toString(); if (got.includes("\n")) done(); });
      sock.on("error", done);
      sock.on("close", done);
    });
    if (banner.startsWith("SSH-2.0")) return;
    await Bun.sleep(200);
  }
  throw new Error(`no SSH server on 127.0.0.1:${port}`);
}

async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs = 90_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check().catch(() => false)) return;
    await Bun.sleep(500);
  }
  throw new Error(`${what} did not come up`);
}

/** A leaf certificate for `name` and `ip`, signed by the CA in `dir`. */
async function issue(dir: string, name: string, ip: string): Promise<void> {
  await must(["openssl", "req", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, `${name}.key`), "-out", join(dir, `${name}.csr`), "-subj", `/CN=${name}`]);
  writeFileSync(join(dir, `${name}.ext`), [
    "basicConstraints=CA:FALSE",
    "keyUsage=critical,digitalSignature,keyEncipherment",
    "extendedKeyUsage=serverAuth",
    `subjectAltName=DNS:${name},IP:${ip}`,
  ].join("\n"));
  await must([
    "openssl", "x509", "-req", "-in", join(dir, `${name}.csr`), "-CA", join(dir, "ca.crt"), "-CAkey", join(dir, "ca.key"),
    "-CAcreateserial", "-out", join(dir, `${name}.crt`), "-days", "2", "-extfile", join(dir, `${name}.ext`),
  ]);
}

export async function startLab(): Promise<Lab> {
  const id = `${process.pid}-${Math.random().toString(36).slice(2, 7)}`;
  const names = { edge: `ppm-t-edge-${id}`, db: `ppm-t-db-${id}`, sshd: `ppm-t-sshd-${id}`, bastion: `ppm-t-bastion-${id}`, pg: `ppm-t-pg-${id}`, mariadb: `ppm-t-mariadb-${id}` };
  const dir = mkdtempSync(join(tmpdir(), "ppm-ssh-ssl-lab-"));
  const containers: string[] = [];
  const networks: string[] = [];
  let pgAdmin: postgres.Sql | null = null;

  const close = async () => {
    await pgAdmin?.end({ timeout: 1 }).catch(() => {});
    if (containers.length) await run(["docker", "rm", "-f", ...containers]);
    for (const n of networks) await run(["docker", "network", "rm", n]);
    rmSync(dir, { recursive: true, force: true });
  };

  try {
    await must(["docker", "build", "-q", "-t", SSHD_IMAGE, join(import.meta.dir, "sshd")]);

    // A subnet of its own, so the certificates can name the servers' addresses.
    let subnet = "";
    for (let attempt = 0; attempt < 8 && !subnet; attempt++) {
      const candidate = `10.213.${40 + Math.floor(Math.random() * 200)}`;
      if ((await run(["docker", "network", "create", "--subnet", `${candidate}.0/24`, names.db])).code === 0) subnet = candidate;
    }
    if (!subnet) throw new Error("no free subnet for the database network");
    networks.push(names.db);
    await must(["docker", "network", "create", names.edge]);
    networks.push(names.edge);
    const sshdIp = `${subnet}.10`;
    const pgIp = `${subnet}.20`;
    const mariadbIp = `${subnet}.30`;

    await must(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "ca.key"), "-out", join(dir, "ca.crt"),
      "-days", "2", "-subj", "/CN=PPM test CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
    await issue(dir, "pg", pgIp);
    await issue(dir, "mariadb", mariadbIp);
    await must(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "ppm-test", "-f", join(dir, "id_plain")]);
    await must(["ssh-keygen", "-q", "-t", "ed25519", "-N", KEY_PASSPHRASE, "-C", "ppm-test", "-f", join(dir, "id_pass")]);

    for (const [name, extra] of [[names.sshd, ["--network-alias", "sshd"]], [names.bastion, []]] as const) {
      await must(["docker", "run", "-d", "--name", name, "--network", names.edge, ...extra, "-p", "127.0.0.1::22", SSHD_IMAGE]);
      containers.push(name);
    }
    await must(["docker", "network", "connect", "--ip", sshdIp, names.db, names.sshd]);

    // The key has to be the server's own and 0600: copied in, then handed over, before it starts.
    const pgSetup = "mkdir -p /certs && cp /certs-src/* /certs/ && chown postgres:postgres /certs/* && chmod 600 /certs/server.key"
      + " && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/certs/server.crt -c ssl_key_file=/certs/server.key";
    await must(["docker", "create", "--name", names.pg, "--network", names.db, "--ip", pgIp, "--network-alias", "pg", "--network-alias", "pg-other",
      "-p", "127.0.0.1::5432", "-e", "POSTGRES_USER=app", "-e", `POSTGRES_PASSWORD=${PG_PASSWORD}`, "-e", "POSTGRES_DB=shop",
      "--entrypoint", "sh", "postgres:17", "-c", pgSetup]);
    containers.push(names.pg);
    await must(["docker", "network", "connect", names.edge, names.pg]);
    const pgFiles = mkdtempSync(join(dir, "pg-"));
    // The chain, leaf first: without the CA, verification fails on a self-signed certificate in it.
    writeFileSync(join(pgFiles, "server.crt"), `${await Bun.file(join(dir, "pg.crt")).text()}${await Bun.file(join(dir, "ca.crt")).text()}`);
    writeFileSync(join(pgFiles, "server.key"), await Bun.file(join(dir, "pg.key")).text());
    await must(["docker", "cp", `${pgFiles}/.`, `${names.pg}:/certs-src/`]);
    await must(["docker", "start", names.pg]);

    const mariadbSetup = "mkdir -p /certs && cp /certs-src/* /certs/ && chown mysql:mysql /certs/* && chmod 600 /certs/server.key"
      + " && exec docker-entrypoint.sh mariadbd --ssl-cert=/certs/server.crt --ssl-key=/certs/server.key --ssl-ca=/certs/ca.crt";
    await must(["docker", "create", "--name", names.mariadb, "--network", names.db, "--ip", mariadbIp, "--network-alias", "mariadb",
      "--network-alias", "mariadb-other", "-p", "127.0.0.1::3306", "-e", `MARIADB_ROOT_PASSWORD=${MARIADB_PASSWORD}`, "-e", "MARIADB_DATABASE=shop",
      "--entrypoint", "sh", "mariadb:11", "-c", mariadbSetup]);
    containers.push(names.mariadb);
    await must(["docker", "network", "connect", names.edge, names.mariadb]);
    const mariadbFiles = mkdtempSync(join(dir, "mariadb-"));
    writeFileSync(join(mariadbFiles, "server.crt"), await Bun.file(join(dir, "mariadb.crt")).text());
    writeFileSync(join(mariadbFiles, "server.key"), await Bun.file(join(dir, "mariadb.key")).text());
    writeFileSync(join(mariadbFiles, "ca.crt"), await Bun.file(join(dir, "ca.crt")).text());
    await must(["docker", "cp", `${mariadbFiles}/.`, `${names.mariadb}:/certs-src/`]);
    await must(["docker", "start", names.mariadb]);

    const keys = `${await Bun.file(join(dir, "id_plain.pub")).text()}${await Bun.file(join(dir, "id_pass.pub")).text()}`;
    for (const name of [names.sshd, names.bastion]) {
      await must(["docker", "exec", "-i", name, "sh", "-c",
        "mkdir -p /home/alice/.ssh && cat > /home/alice/.ssh/authorized_keys && chown -R alice:alice /home/alice/.ssh && chmod 700 /home/alice/.ssh && chmod 600 /home/alice/.ssh/authorized_keys"], keys);
    }

    const sshPort = await publishedPort(names.sshd, 22);
    const bastionPort = await publishedPort(names.bastion, 22);
    const pgPort = await publishedPort(names.pg, 5432);
    const mariadbPort = await publishedPort(names.mariadb, 3306);
    const pgOtherIp = await addressOn(names.pg, names.edge);
    const mariadbOtherIp = await addressOn(names.mariadb, names.edge);
    await Promise.all([waitForSsh(sshPort), waitForSsh(bastionPort)]);

    pgAdmin = postgres(`postgres://app:${PG_PASSWORD}@127.0.0.1:${pgPort}/shop`, { max: 1, onnotice: () => {}, connect_timeout: 3 });
    const admin = pgAdmin;
    // The image starts a server for its first-run setup and then the real one: wait for TLS, which only the real one has.
    await waitFor("Postgres", async () => (await admin`SHOW ssl`)[0]?.ssl === "on");
    await waitFor("MariaDB", async () => (await run(["docker", "exec", names.mariadb, "mariadb", "-h127.0.0.1", "--skip-ssl", "-uroot", `-p${MARIADB_PASSWORD}`, "-e", "SELECT 1"])).code === 0);

    return {
      sshPort, bastionPort, pgPort, mariadbPort, sshdIp, pgIp, mariadbIp, pgOtherIp, mariadbOtherIp,
      ca: join(dir, "ca.crt"),
      key: join(dir, "id_plain"),
      keyWithPassphrase: join(dir, "id_pass"),
      pgAdmin: admin,
      async rekeySshd() {
        await must(["docker", "exec", names.sshd, "sh", "-c", "rm -f /etc/ssh/ssh_host_* && ssh-keygen -A >/dev/null && kill -HUP 1"]);
        await Bun.sleep(300);
        await waitForSsh(sshPort);
      },
      close,
    };
  } catch (e) {
    await close();
    throw e;
  }
}
