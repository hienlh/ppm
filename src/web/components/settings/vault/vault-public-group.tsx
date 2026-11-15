/**
 * The public tier in Settings → Vault: plain text, read freely by the AI, so it is listed with its
 * values and edited without a password. The add box carries the warning not to keep secrets here.
 */
import { Plus } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import type { VaultItemMeta } from "../../../../shared/vault";
import { SectionHeader } from "../settings-rows";
import { PUBLIC_TIER_NOTE } from "./vault-fields";
import { VaultItemRow } from "./vault-item-row";

export function VaultPublicGroup({ items, values, onAdd, onEdit, onMove, onDelete }: {
  items: VaultItemMeta[];
  values: Record<string, string>;
  onAdd: () => void;
  onEdit: (item: VaultItemMeta) => void;
  onMove: (item: VaultItemMeta) => void;
  onDelete: (item: VaultItemMeta) => void;
}) {
  return (
    <section className="space-y-3" data-vault-tier="public">
      <SectionHeader title="Public">{PUBLIC_TIER_NOTE}</SectionHeader>
      <div className="divide-y divide-border rounded-lg border border-border">
        {items.length === 0 && <p className="px-4 py-3 text-xs text-muted-foreground">No items yet.</p>}
        {items.map((item) => (
          <VaultItemRow
            key={item.id}
            item={item}
            publicValue={values[item.id] ?? ""}
            onEdit={() => onEdit(item)}
            onMove={() => onMove(item)}
            onDelete={() => onDelete(item)}
          />
        ))}
      </div>
      <Button className="h-11 md:h-9" onClick={onAdd}><Plus className="size-4" />Add</Button>
    </section>
  );
}
