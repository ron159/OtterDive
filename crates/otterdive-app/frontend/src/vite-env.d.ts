/// <reference types="vite/client" />
/// <reference path="../vendor/marktext-muya/src/types/global.d.ts" />
/// <reference path="../vendor/marktext-muya/src/types/index.d.ts" />

declare module "*?worker" {
  const WorkerFactory: {
    new (): Worker;
  };
  export default WorkerFactory;
}

declare module "monaco-editor/esm/vs/basic-languages/markdown/markdown" {
  export const conf: import("monaco-editor/esm/vs/editor/editor.api").languages.LanguageConfiguration;
  export const language: import("monaco-editor/esm/vs/editor/editor.api").languages.IMonarchLanguage;
}

// Imported only to await the bundled language providers after switching modes.
declare module "monaco-editor/esm/vs/language/html/htmlMode" {}
declare module "monaco-editor/esm/vs/language/css/cssMode" {}
