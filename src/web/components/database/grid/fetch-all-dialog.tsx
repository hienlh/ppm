/**
 * DBGate's Fetch All Rows: reading every remaining row into the browser can be heavy, so it asks
 * first — unless Don't ask again was ticked on this device.
 */
import { useId, useState } from "react";
import { FilterDialogFrame } from "./filter-dialog-frame";

const DONT_ASK_KEY = "ppm-db-fetch-all-dont-ask";

/** Whether Fetch all goes ahead without asking, on this device. */
export function fetchAllAsks(): boolean {
  try {
    return localStorage.getItem(DONT_ASK_KEY) !== "1";
  } catch {
    return true;
  }
}

function stopAsking() {
  try {
    localStorage.setItem(DONT_ASK_KEY, "1");
  } catch {
    // Not kept: the next Fetch all asks again.
  }
}

export function FetchAllDialog({ onFetch, onClose }: { onFetch: () => void; onClose: () => void }) {
  const [dontAsk, setDontAsk] = useState(false);
  const id = useId();
  const fetch = () => {
    if (dontAsk) stopAsking();
    onClose();
    onFetch();
  };
  return (
    <FilterDialogFrame
      title="Fetch All Rows" okLabel="Fetch All"
      description="Load every remaining row of the table into the grid"
      onOk={fetch} onClose={onClose}
    >
      <p className="text-sm text-text-2">
        This will load all remaining rows into memory. For large tables, this may consume a significant amount of memory
        and could affect application performance.
      </p>
      <label htmlFor={id} className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm select-none md:min-h-0">
        <input id={id} type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} className="size-4 accent-primary max-md:size-5" />
        <b className="font-semibold">Don&apos;t ask again</b>
      </label>
    </FilterDialogFrame>
  );
}
