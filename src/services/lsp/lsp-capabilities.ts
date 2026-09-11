/**
 * What PPM tells a language server it can do.
 *
 * This is not a wish list. Servers change their behaviour based on it — they
 * send `insertReplace` edits only if the client claims support, return
 * hierarchical document symbols only if asked, and defer resolving completion
 * documentation only when told the client will ask again. Advertising something
 * the Monaco bridge does not implement produces a response shape nothing reads,
 * which shows up as a feature that silently does nothing.
 *
 * So every entry here has a counterpart in `register-providers.ts` (or, for
 * semantic tokens, in `lsp-semantic-tokens.ts`), and anything not implemented
 * there is deliberately absent.
 */

export const CLIENT_CAPABILITIES = {
  general: {
    // UTF-16 is what a JavaScript string is indexed in, so this is the only
    // encoding the browser side can honestly offer. Servers that support the
    // negotiation will match it instead of assuming UTF-8, which would put
    // every column off by one past the first non-ASCII character on a line.
    positionEncodings: ["utf-16"],
    markdown: { parser: "marked" },
  },
  textDocument: {
    synchronization: {
      dynamicRegistration: false,
      willSave: false,
      willSaveWaitUntil: false,
      didSave: true,
    },
    completion: {
      dynamicRegistration: false,
      contextSupport: true,
      completionItem: {
        snippetSupport: true,
        commitCharactersSupport: false,
        documentationFormat: ["markdown", "plaintext"],
        deprecatedSupport: true,
        preselectSupport: true,
        insertReplaceSupport: true,
        labelDetailsSupport: true,
        resolveSupport: {
          // Asking for these on resolve is what keeps the first completion
          // list fast: the server sends labels now and the expensive parts
          // (doc comments, the import to add) only for the item shown.
          properties: ["documentation", "detail", "additionalTextEdits"],
        },
      },
      completionItemKind: { valueSet: Array.from({ length: 25 }, (_, i) => i + 1) },
      completionList: { itemDefaults: ["editRange", "insertTextFormat", "data"] },
    },
    hover: {
      dynamicRegistration: false,
      contentFormat: ["markdown", "plaintext"],
    },
    signatureHelp: {
      dynamicRegistration: false,
      signatureInformation: {
        documentationFormat: ["markdown", "plaintext"],
        parameterInformation: { labelOffsetSupport: true },
        activeParameterSupport: true,
      },
      contextSupport: true,
    },
    definition: { dynamicRegistration: false, linkSupport: false },
    typeDefinition: { dynamicRegistration: false, linkSupport: false },
    implementation: { dynamicRegistration: false, linkSupport: false },
    references: { dynamicRegistration: false },
    documentHighlight: { dynamicRegistration: false },
    documentSymbol: {
      dynamicRegistration: false,
      hierarchicalDocumentSymbolSupport: true,
      symbolKind: { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) },
    },
    codeAction: {
      dynamicRegistration: false,
      isPreferredSupport: true,
      dataSupport: true,
      resolveSupport: { properties: ["edit"] },
      codeActionLiteralSupport: {
        codeActionKind: {
          valueSet: [
            "", "quickfix", "refactor", "refactor.extract", "refactor.inline",
            "refactor.rewrite", "source", "source.organizeImports", "source.fixAll",
          ],
        },
      },
    },
    rename: {
      dynamicRegistration: false,
      // Without this a rename on a keyword or a string is accepted and then
      // silently does nothing; with it the editor can refuse up front.
      prepareSupport: true,
    },
    formatting: { dynamicRegistration: false },
    rangeFormatting: { dynamicRegistration: false },
    publishDiagnostics: {
      relatedInformation: true,
      tagSupport: { valueSet: [1, 2] }, // Unnecessary, Deprecated
      versionSupport: true,
      codeDescriptionSupport: true,
    },
    inlayHint: {
      dynamicRegistration: false,
      resolveSupport: { properties: ["tooltip", "label.tooltip"] },
    },
    semanticTokens: {
      dynamicRegistration: false,
      // The legend the *client* would prefer. A server answers with its own in
      // the initialize result and indexes into that one, so this is only a
      // hint; the browser reads the server's legend and never assumes these.
      tokenTypes: [
        "namespace", "type", "class", "enum", "interface", "struct", "typeParameter",
        "parameter", "variable", "property", "enumMember", "event", "function",
        "method", "macro", "keyword", "modifier", "comment", "string", "number",
        "regexp", "operator", "decorator",
      ],
      tokenModifiers: [
        "declaration", "definition", "readonly", "static", "deprecated",
        "abstract", "async", "modification", "documentation", "defaultLibrary",
      ],
      // Relative is the only encoding in the specification, and the only one
      // Monaco's provider accepts — the arrays pass through untouched.
      formats: ["relative"],
      requests: {
        // Whole document only. A range request exists for the visible viewport,
        // but Monaco drives its own range provider separately and registering
        // both would ask the server for the same tokens twice.
        range: false,
        full: { delta: true },
      },
      overlappingTokenSupport: false,
      multilineTokenSupport: false,
      serverCancelSupport: false,
      augmentsSyntaxTokens: true,
    },
  },
  workspace: {
    applyEdit: true,
    workspaceFolders: true,
    configuration: true,
    didChangeConfiguration: { dynamicRegistration: false },
    symbol: {
      dynamicRegistration: false,
      symbolKind: { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) },
    },
    workspaceEdit: {
      documentChanges: true,
      resourceOperations: ["create", "rename", "delete"],
      failureHandling: "textOnlyTransactional",
    },
  },
  window: {
    // Claimed so servers report progress instead of appearing hung during a
    // long index; the bridge surfaces it as the "indexing" state.
    workDoneProgress: true,
    showMessage: { messageActionItem: { additionalPropertiesSupport: false } },
  },
} as const;
