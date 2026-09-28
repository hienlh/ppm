import type { ReactNode } from "react";
import { Code, Eye, MoreHorizontal, RefreshCw, Download, WrapText, UserRound, Zap, FileCode } from "@/lib/icons";
import { downloadFile } from "@/lib/file-download";
import { EDITOR_LANGUAGES } from "./editor-language-picker";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuCheckboxItem, DropdownMenuSeparator, DropdownMenuSub,
  DropdownMenuSubTrigger, DropdownMenuSubContent, DropdownMenuRadioGroup, DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";

interface Props {
  mode: "edit" | "preview";
  onModeChange: (mode: "edit" | "preview") => void;
  onRefresh: () => void;
  onReloadCode: () => void;
  refreshing: boolean;
  unsaved: boolean;
  breadcrumb?: ReactNode;
  filePath: string;
  projectName?: string;
  wordWrap: boolean;
  onToggleWordWrap: () => void;
  inlineBlame: boolean;
  onToggleInlineBlame?: () => void;
  language: string;
  onLanguageChange: (language: string) => void;
  lspEnabled: boolean;
  onToggleLsp?: (enabled: boolean) => void;
}

const actionClass = "flex items-center justify-center gap-1.5 rounded px-2 min-h-11 min-w-11 md:min-h-7 md:min-w-7 text-xs text-muted-foreground hover:text-foreground hover:bg-muted";
// Keep action icons near the edge; checked states occupy the trailing slot.
const menuClass = "min-h-11 md:min-h-8 px-2";
const checkboxClass = `${menuClass} pr-8 [&>span]:left-auto [&>span]:right-2`;

/** One row shared by code and preview; auxiliary editor actions live in the menu. */
export function HtmlPreviewToolbar(props: Props) {
  const { mode, onModeChange, onRefresh, unsaved, breadcrumb } = props;
  return (
    <div className="flex items-center gap-2 md:gap-1 border-b border-border bg-background px-2 shrink-0 h-12 md:h-8"
      role="toolbar" aria-label="HTML preview">
      <div className="hidden md:flex flex-1 min-w-0 overflow-hidden">{breadcrumb}</div>
      {mode === "preview" && (
        <button type="button" onClick={onRefresh} title="Reload the original HTML file" aria-label="Refresh preview" className={actionClass}>
          <RefreshCw className="size-4" />
        </button>
      )}
      {([["edit", "Code", Code], ["preview", "Preview", Eye]] as const).map(([value, label, Icon]) => (
        <button key={value} type="button" aria-pressed={mode === value} onClick={() => onModeChange(value)}
          className={`${actionClass} ${mode === value ? "bg-muted text-foreground" : ""}`}>
          <Icon className="size-3.5" />{label}
        </button>
      ))}
      {unsaved && <span role="status" title="Preview uses the saved file" aria-label="Preview uses the saved file" className="text-amber-500 text-xs">●</span>}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" title="More HTML actions" aria-label="More HTML actions" className={`${actionClass} ml-auto md:ml-0`}>
            <MoreHorizontal className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          {mode === "edit" && <DropdownMenuItem className={menuClass} disabled={unsaved || props.refreshing} onSelect={props.onReloadCode}><RefreshCw />Reload code from disk</DropdownMenuItem>}
          <DropdownMenuItem className={menuClass} onSelect={() => void downloadFile(props.projectName ?? "", props.filePath)}><Download />Download</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem className={checkboxClass} checked={props.wordWrap} onCheckedChange={props.onToggleWordWrap}><WrapText className="size-4 text-muted-foreground" />Word wrap</DropdownMenuCheckboxItem>
          {props.onToggleInlineBlame && <DropdownMenuCheckboxItem className={checkboxClass} checked={props.inlineBlame} onCheckedChange={props.onToggleInlineBlame}><UserRound className="size-4 text-muted-foreground" />Inline blame</DropdownMenuCheckboxItem>}
          {props.onToggleLsp && <DropdownMenuCheckboxItem className={checkboxClass} checked={props.lspEnabled} onCheckedChange={props.onToggleLsp}><Zap className="size-4 text-muted-foreground" />Language server</DropdownMenuCheckboxItem>}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className={`${menuClass} gap-2`}><FileCode className="size-4 text-muted-foreground" />Editor language</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-80 overflow-y-auto">
              <DropdownMenuRadioGroup value={props.language} onValueChange={props.onLanguageChange}>
                {EDITOR_LANGUAGES.map((language) => <DropdownMenuRadioItem key={language.id} className="min-h-11 md:min-h-8" value={language.id}>{language.label}</DropdownMenuRadioItem>)}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
