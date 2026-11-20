/**
 * `/?openVault=<item id>` (or `=all`): the address a vault card's Telegram notice opens. It lands
 * on Settings → Vault, on that item. The address names an item id only; the page behind it is
 * PPM's own, behind PPM's sign-in, and a locked tier asks for its password there as it always does.
 */
import { isVaultItemId, VAULT_LINK_ALL, VAULT_LINK_PARAM } from "../../shared/vault";

export interface VaultDeepLink {
  /** The item to show, or null for the pane itself. */
  itemId: string | null;
}

export function vaultLinkFromSearch(search: string): VaultDeepLink | null {
  const raw = new URLSearchParams(search).get(VAULT_LINK_PARAM);
  if (raw === null) return null;
  if (raw === VAULT_LINK_ALL || raw === "") return { itemId: null };
  return isVaultItemId(raw) ? { itemId: raw } : { itemId: null };
}

/** The current address without `openVault`, so a reload does not open the pane again. */
export function addressWithoutVaultLink(href: string): string {
  const url = new URL(href);
  url.searchParams.delete(VAULT_LINK_PARAM);
  return url.pathname + url.search + url.hash;
}
