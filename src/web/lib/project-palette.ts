export const PROJECT_PALETTE = [
  'linear-gradient(135deg, #667eea, #764ba2)',
  'linear-gradient(135deg, #f5576c, #f093fb)',
  'linear-gradient(135deg, #4facfe, #00c6ff)',
  'linear-gradient(135deg, #43e97b, #38f9d7)',
  'linear-gradient(135deg, #fa709a, #fee140)',
  'linear-gradient(135deg, #a18cd1, #6a3de8)',
  'linear-gradient(135deg, #fd7043, #ff8a65)',
  'linear-gradient(135deg, #26c6da, #0097a7)',
  'linear-gradient(135deg, #ab47bc, #7b1fa2)',
  'linear-gradient(135deg, #ef5350, #b71c1c)',
  'linear-gradient(135deg, #1976d2, #42a5f5)',
  'linear-gradient(135deg, #2e7d32, #66bb6a)',
] as const;

export function resolveProjectColor(color: string | undefined, index: number): string {
  return color ?? PROJECT_PALETTE[index % PROJECT_PALETTE.length]!;
}
