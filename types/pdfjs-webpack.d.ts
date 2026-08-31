/** Adds TypeScript declarations for PDF.js's webpack-compatible legacy entry. */
declare module "pdfjs-dist/legacy/webpack.mjs" {
  export * from "pdfjs-dist/legacy/build/pdf.mjs"
}
