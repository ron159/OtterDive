/// <reference types="vite/client" />
/// <reference path="../vendor/marktext-muya/src/types/global.d.ts" />
/// <reference path="../vendor/marktext-muya/src/types/index.d.ts" />

declare module "*?worker" {
  const WorkerFactory: {
    new (): Worker;
  };
  export default WorkerFactory;
}

declare module "monaco-editor/languages/definitions/markdown/markdown" {
  export const conf: import("monaco-editor/editor").languages.LanguageConfiguration;
  export const language: import("monaco-editor/editor").languages.IMonarchLanguage;
}

// Imported only to await the bundled language providers after switching modes.
declare module "monaco-editor/languages/features/html/htmlMode" {}
declare module "monaco-editor/languages/features/css/cssMode" {}
