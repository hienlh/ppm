/**
 * General: which engine, where the server is and how to log in, then how PPM shows the connection.
 * The order and the words are DBGate's; the engine tiles are PPM's own.
 */
import { DriverMissingNotice } from "../driver-missing-notice";
import { ConnectionColorPicker } from "../connection-color-picker";
import { DEFAULT_SOCKET, DEFAULT_USER, DEFAULT_PORT, URL_SCHEME, type ServerDbType } from "../../../../shared/db-connection-url";
import { PASSWORD_MODES, type PasswordMode } from "../../../../shared/db-connection-config";
import { dialectNameOf } from "../../../../shared/db-types";
import {
  aiAccessAllowed, currentDatabase, defaultName, nameTaken, passwordModeHelp, targetOf, urlHelp,
  type FormField,
} from "./connection-form-state";
import { CheckRow, Field, PasswordInput, PathInput, RadioRow, SelectInput, TextInput } from "./form-controls";
import { EngineTiles } from "./engine-tiles";
import { DatabasePicker } from "./database-picker";
import type { ConnectionForm } from "./use-connection-form";

const PASSWORD_MODE_LABELS: Record<PasswordMode, string> = {
  save: "Save and encrypt",
  askPassword: "Don't save, ask for password",
  askUser: "Don't save, ask for login and password",
};

/** Enter in a one-line box is Connect, as in DBGate. */
export function enterConnects(form: ConnectionForm) {
  return (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      form.connect();
    }
  };
}

export function ConnectionGeneralPane({ form }: { form: ConnectionForm }) {
  const { values, update, ctx, editing, problem, register } = form;
  const onEnter = enterConnects(form);
  const errorOf = (field: FormField) => (problem?.field === field ? problem.message : null);
  const server: ServerDbType | null = values.type === "sqlite" ? null : values.type;
  const urlMode = !!server && values.entry === "url";
  const mode = values.passwordMode;
  const asks = mode !== "save";
  const database = currentDatabase(values, ctx);
  const taken = nameTaken(values, ctx);
  const aiAllowed = aiAccessAllowed(values);
  const grid = "grid grid-cols-1 gap-3 @[560px]:grid-cols-6";

  return (
    <div className="grid content-start gap-4 md:gap-[18px]">
      <Field label="Connection type" labelId="cf-type-label" error={errorOf("type")} help={editing ? "A saved connection keeps its type." : null}>
        <EngineTiles value={values.type} locked={!!editing} onPick={form.setType} labelId="cf-type-label" />
      </Field>

      {form.missingDriver && <DriverMissingNotice driver={form.missingDriver} />}

      {server && (
        <div role="radiogroup" aria-label="How to enter the connection" className="flex flex-col md:flex-row md:flex-wrap md:gap-x-[22px] md:gap-y-1.5">
          <RadioRow name="cf-entry" value="fields" checked={values.entry === "fields"} onChange={() => form.setEntry("fields")}>
            Fill database connection details
          </RadioRow>
          <RadioRow name="cf-entry" value="url" checked={values.entry === "url"} onChange={() => form.setEntry("url")}>
            Use database URL
          </RadioRow>
        </div>
      )}

      {server && urlMode && (
        <Field label="Database URL" htmlFor="cf-url" help={errorOf("url") ? null : urlHelp(values, ctx, false)} error={errorOf("url")}>
          <TextInput
            id="cf-url"
            ref={register("url")}
            mono
            value={values.url}
            invalid={!!errorOf("url")}
            onChange={(e) => form.setUrl(e.target.value)}
            onKeyDown={onEnter}
            placeholder={`e.g. ${URL_SCHEME[server]}://user:password@localhost:${DEFAULT_PORT[server]}/shop`}
          />
        </Field>
      )}

      {server && !urlMode && (
        <div className={grid}>
          <Field label="Connection mode" htmlFor="cf-connmode" className="@[560px]:col-span-6">
            <SelectInput id="cf-connmode" value={values.connMode} onChange={(e) => update({ connMode: e.target.value as "host" | "socket" })}>
              <option value="host">Host and port</option>
              <option value="socket">Socket</option>
            </SelectInput>
          </Field>
          {values.connMode === "host" ? (
            <>
              <Field label="Server" htmlFor="cf-host" className="@[560px]:col-span-4" error={errorOf("host")}
                help={values.sshEnabled ? "As the SSH server sees it: often localhost." : "Reached from the PPM host, not from this browser."}>
                <TextInput id="cf-host" ref={register("host")} mono value={values.host} invalid={!!errorOf("host")} placeholder="localhost"
                  onChange={(e) => update({ host: e.target.value })} onKeyDown={onEnter} />
              </Field>
              <Field label="Port" htmlFor="cf-port" className="@[560px]:col-span-2" error={errorOf("port")}>
                <TextInput id="cf-port" ref={register("port")} mono inputMode="numeric" value={values.port} invalid={!!errorOf("port")}
                  placeholder={String(DEFAULT_PORT[server])}
                  onChange={(e) => update({ port: e.target.value })} onKeyDown={onEnter} />
              </Field>
            </>
          ) : (
            <Field label="Socket path" htmlFor="cf-socket" className="@[560px]:col-span-6" error={errorOf("socket")} help="A Unix socket on the PPM host.">
              <TextInput id="cf-socket" ref={register("socket")} mono value={values.socket} invalid={!!errorOf("socket")}
                placeholder={DEFAULT_SOCKET[server]}
                onChange={(e) => update({ socket: e.target.value })} onKeyDown={onEnter} />
            </Field>
          )}
          {mode !== "askUser" && (
            <Field label="User" htmlFor="cf-user" className={mode === "save" ? "@[560px]:col-span-3" : "@[560px]:col-span-6"}>
              <TextInput id="cf-user" ref={register("user")} mono value={values.user} placeholder={DEFAULT_USER[server]}
                onChange={(e) => update({ user: e.target.value })} onKeyDown={onEnter} />
            </Field>
          )}
          {!asks && (
            <Field label="Password" htmlFor="cf-password" className="@[560px]:col-span-3">
              <PasswordInput
                id="cf-password"
                ref={register("password")}
                value={values.password}
                placeholder={editing?.passwordSaved ? "Saved on the PPM host" : ""}
                onChange={(e) => update({ password: e.target.value })}
                onKeyDown={onEnter}
              />
            </Field>
          )}
          <Field label="Password mode" htmlFor="cf-passmode" className="@[560px]:col-span-6" error={errorOf("passwordMode")} help={passwordModeHelp(mode)}>
            <SelectInput id="cf-passmode" ref={register("passwordMode")} value={mode} onChange={(e) => update({ passwordMode: e.target.value as PasswordMode })}>
              {PASSWORD_MODES.map((m) => <option key={m} value={m}>{PASSWORD_MODE_LABELS[m]}</option>)}
            </SelectInput>
          </Field>
        </div>
      )}

      {!server && (
        <Field
          label="Database file"
          htmlFor="cf-path"
          error={errorOf("path")}
          help="A path on the PPM host. The file is opened in place, never uploaded."
        >
          <PathInput id="cf-path" ref={register("path")} value={values.path} invalid={!!errorOf("path")} placeholder="~/data/app.db"
            onChange={(e) => update({ path: e.target.value })} onKeyDown={onEnter}
            accept={[".db", ".sqlite", ".sqlite3", ".db3"]} pickerTitle="Choose a SQLite database" onPick={(path) => update({ path })} />
        </Field>
      )}

      <div className="grid gap-1 md:gap-3">
        <CheckRow
          id="cf-readonly"
          checked={values.readonly}
          onChange={(readonly) => update({ readonly })}
          title="Is read only"
          help={
            <>
              Blocks writes inside the database, including SQL the AI runs.
              {dialectNameOf(values.type) === "postgres" && " For a hard guarantee — even pg_terminate_backend() — connect as a user with only SELECT rights."}
            </>
          }
        />
        <CheckRow
          id="cf-ai"
          checked={values.aiAccess && aiAllowed}
          disabled={!aiAllowed}
          onChange={(aiAccess) => update({ aiAccess })}
          title="Available to the AI chat"
          help={aiAllowed
            ? "The AI can see this connection and run SQL on it."
            : "Not while PPM asks for the password: the AI's commands run on their own, with nobody to ask."}
        />
      </div>

      {server && (
        <div className={grid}>
          {!urlMode && (
            <Field
              label="Default database"
              htmlFor="cf-database"
              className="@[560px]:col-span-6"
              help={form.dbError
                ? { tone: "bad", text: form.dbError }
                : database ? "Opened when you connect." : "Leave it empty to browse every database on the server."}
            >
              <DatabasePicker
                id="cf-database"
                ref={register("database")}
                value={values.database}
                onChange={(database) => update({ database })}
                onKeyDown={onEnter}
                databases={form.databases}
                busy={form.dbBusy}
                open={form.dbMenuOpen}
                onOpenChange={form.setDbMenuOpen}
                onRequestList={form.listDatabases}
                subtitle={`${form.databases?.length ?? 0} database${form.databases?.length === 1 ? "" : "s"} on ${targetOf(values, ctx)}`}
              />
            </Field>
          )}
          {database && (
            <CheckRow
              id="cf-single"
              className="@[560px]:col-span-6"
              checked={values.singleDatabase}
              onChange={(singleDatabase) => update({ singleDatabase })}
              title={`Use only database “${database}”`}
              help="The tree shows this database alone, not the server's list."
            />
          )}
        </div>
      )}

      <div className={grid}>
        <Field label="Display name" htmlFor="cf-name" className="@[560px]:col-span-4" error={taken ? "Another connection already has this name." : errorOf("name")}>
          <TextInput id="cf-name" ref={register("name")} value={values.name} invalid={taken || !!errorOf("name")} placeholder={defaultName(values, ctx)}
            onChange={(e) => update({ name: e.target.value })} onKeyDown={onEnter} />
        </Field>
        <Field label="Folder" htmlFor="cf-folder" className="@[560px]:col-span-2">
          <TextInput id="cf-folder" list="cf-folders" value={values.folder} placeholder="No folder"
            onChange={(e) => update({ folder: e.target.value })} onKeyDown={onEnter} />
          <datalist id="cf-folders">
            {form.folders.map((f) => <option key={f} value={f} />)}
          </datalist>
        </Field>
        <Field label="Color" labelId="cf-color-label" className="@[560px]:col-span-6">
          <ConnectionColorPicker value={values.color} onChange={(color) => update({ color })} labelId="cf-color-label" />
        </Field>
      </div>
    </div>
  );
}
