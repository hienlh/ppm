/**
 * Slash/file picker state + handlers for <ExtensionComposer>, split out of that file to
 * keep it under the project's file-size guideline. No JSX lives here (the .tsx extension
 * only matches this phase's file-ownership glob) — it is a plain hook.
 *
 * MessageInput renders no pickers itself; it only emits state-change callbacks and
 * consumes the selected item (see message-input.tsx). Every host that embeds MessageInput
 * must wire SlashCommandPicker + FilePicker around it — chat-tab.tsx does this for chat
 * tabs, this hook does the same for the extension composer dialog. If MessageInput's
 * picker props ever change, mirror the change in both places.
 */
import { useState, useCallback } from "react";
import { api, projectUrl } from "@/lib/api-client";
import type { SlashItem } from "@/components/chat/slash-command-picker";
import type { FileNode } from "../../../types/project";

export function useExtensionComposerPickers(projectName: string) {
  const [slashItems, setSlashItems] = useState<SlashItem[]>([]);
  const [showSlashPicker, setShowSlashPicker] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [slashSelected, setSlashSelected] = useState<SlashItem | null>(null);
  const [slashRecentNames, setSlashRecentNames] = useState<string[]>([]);

  const [fileItems, setFileItems] = useState<FileNode[]>([]);
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [fileFilter, setFileFilter] = useState("");
  const [fileSelected, setFileSelected] = useState<FileNode | null>(null);

  const handleSlashItemsLoaded = useCallback((items: SlashItem[], recentNames?: string[]) => {
    setSlashItems(items);
    if (recentNames) setSlashRecentNames(recentNames);
  }, []);

  const handleSlashStateChange = useCallback((visible: boolean, filter: string) => {
    setShowSlashPicker(visible);
    setSlashFilter(filter);
  }, []);

  const handleSlashSelect = useCallback(
    (item: SlashItem) => {
      setSlashSelected(item);
      setShowSlashPicker(false);
      setSlashFilter("");
      setTimeout(() => setSlashSelected(null), 50);
      if (projectName) {
        api.post(`${projectUrl(projectName)}/chat/slash-recents`, { name: item.name, type: item.type }).catch(() => {});
        setSlashRecentNames((prev) => [item.name, ...prev.filter((n) => n !== item.name)].slice(0, 5));
      }
    },
    [projectName],
  );

  const handleSlashClose = useCallback(() => {
    setShowSlashPicker(false);
    setSlashFilter("");
  }, []);

  const handleFileStateChange = useCallback((visible: boolean, filter: string) => {
    setShowFilePicker(visible);
    setFileFilter(filter);
  }, []);

  const handleFileSelect = useCallback((item: FileNode) => {
    setFileSelected(item);
    setShowFilePicker(false);
    setFileFilter("");
    setTimeout(() => setFileSelected(null), 50);
  }, []);

  const handleFileClose = useCallback(() => {
    setShowFilePicker(false);
    setFileFilter("");
  }, []);

  return {
    slashItems,
    showSlashPicker,
    slashFilter,
    slashSelected,
    slashRecentNames,
    fileItems,
    showFilePicker,
    fileFilter,
    fileSelected,
    handleSlashItemsLoaded,
    handleSlashStateChange,
    handleSlashSelect,
    handleSlashClose,
    setFileItems,
    handleFileStateChange,
    handleFileSelect,
    handleFileClose,
  };
}
