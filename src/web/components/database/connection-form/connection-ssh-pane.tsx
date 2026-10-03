/**
 * SSH Tunnel: the SSH server PPM opens a tunnel to from its own host, and how it logs in there.
 * The fields and their order are DBGate's. Unticked, what was typed stays and is not used, so the
 * fields are shown but cannot be edited.
 */
import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2 } from "@/lib/icons";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { DriverMissingNotice } from "../driver-missing-notice";
import { DEFAULT_SSH_PORT, SSH_AUTH_METHODS, type SshAuthMethod } from "../../../../shared/db-connection-config";
import type { FormField } from "./connection-form-state";
import { CheckRow, Field, PasswordInput, PathInput, SelectInput, TextInput } from "./form-controls";
import { enterConnects } from "./connection-general-pane";
import type { ConnectionForm } from "./use-connection-form";

const AUTH_LABELS: Record<SshAuthMethod, string> = {
  password: "Username & password",
  agent: "SSH agent",
  keyFile: "Key file",
};

/** `GET /api/db/ssh/agent`: the agent the PPM host has, and who an empty Login logs in as. */
interface SshAgentInfo {
  found: boolean;
  socket: string | null;
  user: string;
}

/** The fieldset's own box taken away, so it lays out like the rest of the form. */
export const fieldsetClass = "m-0 min-w-0 border-0 p-0 [&:disabled_label]:text-text-subtle";

export function ConnectionSshPane({ form }: { form: ConnectionForm }) {
  const { values, update, editing, problem, register } = form;
  const [agent, setAgent] = useState<SshAgentInfo | null>(null);
  const onEnter = enterConnects(form);
  const errorOf = (field: FormField) => (problem?.field === field ? problem.message : null);
  const on = values.sshEnabled;
  const auth = values.sshAuth;

  // Asked again on picking the agent: one may have been started since the tab opened.
  useEffect(() => {
    let cancelled = false;
    api.get<SshAgentInfo>("/api/db/ssh/agent").then((info) => { if (!cancelled) setAgent(info); }).catch(() => {
      // The line stays away; a Test through the agent says what is wrong.
    });
    return () => { cancelled = true; };
  }, [auth === "agent"]);

  return (
    <div className="grid content-start gap-4 md:gap-[18px]">
      <CheckRow
        id="cf-ssh"
        checked={on}
        onChange={(sshEnabled) => update({ sshEnabled })}
        title="Use SSH tunnel"
        help="PPM opens the tunnel from its host, then connects through it."
      />

      {form.missingSshDriver && <DriverMissingNotice driver={form.missingSshDriver} />}

      <fieldset disabled={!on} className={cn(fieldsetClass, "grid grid-cols-1 gap-3 @[560px]:grid-cols-6")}>
        <Field
          label="Host"
          htmlFor="cf-ssh-host"
          className="@[560px]:col-span-4"
          error={errorOf("sshHost")}
          help="The server on General is then as this host sees it: often localhost."
        >
          <TextInput id="cf-ssh-host" ref={register("sshHost")} mono value={values.sshHost} invalid={!!errorOf("sshHost")}
            placeholder="ssh.example.com" onChange={(e) => update({ sshHost: e.target.value })} onKeyDown={onEnter} />
        </Field>
        <Field label="Port" htmlFor="cf-ssh-port" className="@[560px]:col-span-2" error={errorOf("sshPort")}>
          <TextInput id="cf-ssh-port" ref={register("sshPort")} mono inputMode="numeric" value={values.sshPort} invalid={!!errorOf("sshPort")}
            placeholder={String(DEFAULT_SSH_PORT)} onChange={(e) => update({ sshPort: e.target.value })} onKeyDown={onEnter} />
        </Field>
        <Field
          label="Bastion host (Jump host)"
          htmlFor="cf-ssh-jump"
          optional
          className="@[560px]:col-span-6"
          error={errorOf("sshBastionHost")}
          help="Reached first, with the same login, as ssh -J does."
        >
          <TextInput id="cf-ssh-jump" ref={register("sshBastionHost")} mono value={values.sshBastionHost} invalid={!!errorOf("sshBastionHost")}
            placeholder="user@jump.example.com" onChange={(e) => update({ sshBastionHost: e.target.value })} onKeyDown={onEnter} />
        </Field>
        <Field label="SSH Authentication" htmlFor="cf-ssh-auth" className="@[560px]:col-span-6">
          <SelectInput id="cf-ssh-auth" ref={register("sshAuth")} value={auth} onChange={(e) => update({ sshAuth: e.target.value as SshAuthMethod })}>
            {SSH_AUTH_METHODS.map((m) => <option key={m} value={m}>{AUTH_LABELS[m]}</option>)}
          </SelectInput>
        </Field>
        <Field label="Login" htmlFor="cf-ssh-login" className={auth === "password" ? "@[560px]:col-span-3" : "@[560px]:col-span-6"}>
          <TextInput id="cf-ssh-login" ref={register("sshUser")} mono value={values.sshUser} placeholder={agent?.user ?? ""}
            onChange={(e) => update({ sshUser: e.target.value })} onKeyDown={onEnter} />
        </Field>
        {auth === "password" && (
          <Field label="Password" htmlFor="cf-ssh-pass" className="@[560px]:col-span-3">
            <PasswordInput id="cf-ssh-pass" ref={register("sshPassword")} value={values.sshPassword}
              placeholder={editing?.sshPasswordSaved ? "Saved on the PPM host" : ""}
              onChange={(e) => update({ sshPassword: e.target.value })} onKeyDown={onEnter} />
          </Field>
        )}
        {auth === "keyFile" && (
          <>
            <Field label="Private key file" htmlFor="cf-ssh-key" className="@[560px]:col-span-3" error={errorOf("sshKeyFile")}>
              <PathInput id="cf-ssh-key" ref={register("sshKeyFile")} value={values.sshKeyFile} invalid={!!errorOf("sshKeyFile")}
                placeholder="~/.ssh/id_ed25519" onChange={(e) => update({ sshKeyFile: e.target.value })} onKeyDown={onEnter}
                pickerTitle="Choose the private key file" pickerRoot="~/.ssh" onPick={(sshKeyFile) => update({ sshKeyFile })} />
            </Field>
            <Field label="Key file passphrase" htmlFor="cf-ssh-keypass" optional className="@[560px]:col-span-3">
              <PasswordInput id="cf-ssh-keypass" ref={register("sshPassphrase")} value={values.sshPassphrase}
                placeholder={editing?.sshPassphraseSaved ? "Saved on the PPM host" : ""}
                onChange={(e) => update({ sshPassphrase: e.target.value })} onKeyDown={onEnter} />
            </Field>
          </>
        )}
        {auth === "agent" && agent && (
          <div data-testid="db-ssh-agent" data-found={agent.found} className="@[560px]:col-span-6 flex items-start gap-2 text-[13px] md:text-[12.5px]">
            {agent.found
              ? <CheckCircle2 className="mt-px size-4 shrink-0 text-success" />
              : <AlertCircle className="mt-px size-4 shrink-0 text-warning" />}
            <span className="min-w-0 break-words" title={agent.socket ?? undefined}>
              {agent.found ? "SSH agent found on the PPM host" : "No SSH agent found on the PPM host."}
              {!agent.found && (
                <small className="block text-[12.5px] md:text-[11.5px] text-text-subtle">
                  Start one there and add your key (ssh-add), or pick Key file.
                </small>
              )}
            </span>
          </div>
        )}
      </fieldset>
    </div>
  );
}
