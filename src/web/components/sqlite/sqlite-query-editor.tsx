import { SqlQueryEditor } from "../database/sql-query-editor";

interface Props {
  onExecute: (sql: string) => void;
  loading: boolean;
}

export function SqliteQueryEditor({ onExecute, loading }: Props) {
  return <SqlQueryEditor onExecute={onExecute} loading={loading} />;
}
