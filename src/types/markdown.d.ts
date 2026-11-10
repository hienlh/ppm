// Markdown imported `with { type: "text" }` (the bundled PPM skill) is its text.
declare module "*.md" {
  const text: string;
  export default text;
}
