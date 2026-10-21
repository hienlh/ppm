import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  createDesignShare, deleteDesignShare, listDesignShares, updateDesignShare,
} from "@/lib/design/api-design-shares";
import { deleteShareLinkThreads } from "@/lib/design/api-design-comments";
import type {
  CreateDesignShareInput, DesignShareLink, UpdateDesignShareInput, UpdateDesignShareResult,
} from "../../../../shared/design-share-types";

/**
 * One design's share links while the Share dialog is open. Every action updates the list
 * from the server's answer, so a change shows without a reload; a failure is a toast and
 * the action resolves to `null` (create throws instead, so the form can show the reason).
 */

export interface ShareLinksFeature {
  links: DesignShareLink[] | null;
  error: string | null;
  refresh: () => Promise<void>;
  create: (input: CreateDesignShareInput) => Promise<DesignShareLink>;
  update: (id: string, patch: UpdateDesignShareInput, failure: string) => Promise<UpdateDesignShareResult | null>;
  remove: (id: string) => Promise<boolean>;
  deleteComments: (id: string) => Promise<boolean>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function useShareLinks(projectName: string, slug: string, open: boolean): ShareLinksFeature {
  const [links, setLinks] = useState<DesignShareLink[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      // Newest first, the same order a link created in this dialog takes.
      setLinks((await listDesignShares(projectName, slug)).sort((a, b) => b.createdAt - a.createdAt));
      setError(null);
    } catch (e) {
      setError(message(e) || "Could not load the share links");
    }
  }, [projectName, slug]);

  useEffect(() => {
    if (!open) return;
    void refresh();
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [open, refresh]);

  const replace = (link: DesignShareLink) =>
    setLinks((list) => (list ?? []).map((l) => (l.id === link.id ? link : l)));

  const create = useCallback(async (input: CreateDesignShareInput) => {
    const link = await createDesignShare(projectName, slug, input);
    setLinks((list) => [link, ...(list ?? []).filter((l) => l.id !== link.id)]);
    return link;
  }, [projectName, slug]);

  const update = useCallback(async (id: string, patch: UpdateDesignShareInput, failure: string) => {
    try {
      const result = await updateDesignShare(projectName, slug, id, patch);
      replace(result.link);
      return result;
    } catch (e) {
      toast.error(failure, { description: message(e) });
      return null;
    }
  }, [projectName, slug]);

  const remove = useCallback(async (id: string) => {
    try {
      await deleteDesignShare(projectName, slug, id);
      setLinks((list) => (list ?? []).filter((l) => l.id !== id));
      return true;
    } catch (e) {
      toast.error("Could not delete the link", { description: message(e) });
      return false;
    }
  }, [projectName, slug]);

  const deleteComments = useCallback(async (id: string) => {
    try {
      await deleteShareLinkThreads(projectName, slug, id);
      return true;
    } catch (e) {
      toast.error("Could not delete the link's comments", { description: message(e) });
      return false;
    }
  }, [projectName, slug]);

  return { links, error, refresh, create, update, remove, deleteComments };
}
