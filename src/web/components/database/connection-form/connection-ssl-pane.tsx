/**
 * SSL: DBGate's fields. The two checkboxes are the URL's own TLS parameter (`sslmode`, `ssl-mode`
 * for MySQL), so ticking one here is the same as writing it on General, and a URL pasted with it
 * shows up ticked. The files are paths on the PPM host, read each time a connection opens.
 */
import { cn } from "@/lib/utils";
import { setSslChecks, sslChecks, sslParamOf, type FormField } from "./connection-form-state";
import { CheckRow, Field, Help, PasswordInput, PathInput } from "./form-controls";
import { enterConnects } from "./connection-general-pane";
import { fieldsetClass } from "./connection-ssh-pane";
import type { ConnectionForm } from "./use-connection-form";

export function ConnectionSslPane({ form }: { form: ConnectionForm }) {
  const { values, update, ctx, editing, problem, register } = form;
  const onEnter = enterConnects(form);
  const errorOf = (field: FormField) => (problem?.field === field ? problem.message : null);
  const checks = sslChecks(values, ctx);
  const on = !!checks?.useSsl;
  const param = sslParamOf(values, ctx);
  const set = (useSsl: boolean, rejectUnauthorized: boolean) => update((v) => setSslChecks(v, ctx, useSsl, rejectUnauthorized));

  return (
    <div className="grid content-start gap-4 md:gap-[18px]">
      <CheckRow
        id="cf-ssl"
        checked={on}
        disabled={!checks}
        onChange={(useSsl) => set(useSsl, checks?.rejectUnauthorized ?? false)}
        title="Use SSL"
        help={checks
          ? "The certificate files below are read on the PPM host."
          : "Enter a URL PPM can read on General first: SSL is set in it."}
      />

      <fieldset disabled={!on} className={cn(fieldsetClass, "grid grid-cols-1 gap-3")}>
        <Field label="CA Cert" htmlFor="cf-ssl-ca" optional error={errorOf("sslCa")}>
          <PathInput id="cf-ssl-ca" ref={register("sslCa")} value={values.sslCa} invalid={!!errorOf("sslCa")} placeholder="~/certs/ca.pem"
            onChange={(e) => update({ sslCa: e.target.value })} onKeyDown={onEnter}
            pickerTitle="Choose the CA certificate" onPick={(sslCa) => update({ sslCa })} />
        </Field>
        <Field label="Certificate" htmlFor="cf-ssl-cert" optional error={errorOf("sslCert")}>
          <PathInput id="cf-ssl-cert" ref={register("sslCert")} value={values.sslCert} invalid={!!errorOf("sslCert")} placeholder="~/certs/client.crt"
            onChange={(e) => update({ sslCert: e.target.value })} onKeyDown={onEnter}
            pickerTitle="Choose the client certificate" onPick={(sslCert) => update({ sslCert })} />
        </Field>
        <Field label="Certificate key file password" htmlFor="cf-ssl-certpass" optional>
          <PasswordInput id="cf-ssl-certpass" ref={register("sslKeyPassword")} value={values.sslKeyPassword}
            placeholder={editing?.sslKeyPasswordSaved ? "Saved on the PPM host" : ""}
            onChange={(e) => update({ sslKeyPassword: e.target.value })} onKeyDown={onEnter} />
        </Field>
        <Field label="Key file" htmlFor="cf-ssl-key" optional error={errorOf("sslKey")}>
          <PathInput id="cf-ssl-key" ref={register("sslKey")} value={values.sslKey} invalid={!!errorOf("sslKey")} placeholder="~/certs/client.key"
            onChange={(e) => update({ sslKey: e.target.value })} onKeyDown={onEnter}
            pickerTitle="Choose the client key file" onPick={(sslKey) => update({ sslKey })} />
        </Field>
        <CheckRow
          id="cf-ssl-reject"
          checked={on && !!checks?.rejectUnauthorized}
          disabled={!on}
          onChange={(reject) => set(true, reject)}
          title="Reject unauthorized"
          help="Refuse a certificate that no trusted CA signed or that names another server."
        />
      </fieldset>
      {checks && <Help line={{ tone: "plain", text: param ? `In the URL: ${param}.` : "The URL sets no SSL parameter: the connection is not encrypted." }} />}
    </div>
  );
}
