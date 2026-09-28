/**
 * Strings a hostile manifest, request or page might try to smuggle into a stylesheet
 * through a tweak value: rule and comment breakouts, markup, script URLs, legacy
 * `expression()`, unbalanced parentheses (which swallow every later `;` and `}` in the
 * sheet), quotes, backslashes, newlines and padding. Shared by every layer that checks one.
 */
export const TWEAK_INJECTIONS = [
  "red;} body{display:none}", "red;}x{", "</style><script>alert(1)</script>", "url(javascript:alert(1))",
  "url(x.png)", "expression(alert(1))", "a /* b", "b */ a", "/*", "*/", "red\nblue", "red;", "red}", "}", ";",
  "'quoted'", '"quoted"', "back\\slash", "calc(1px", "calc(1px))", "(1px)", " padded", "padded ", "", "x".repeat(65),
];
