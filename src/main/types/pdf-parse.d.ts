// We import the lib file directly (not the package root) because pdf-parse's
// index.js runs debug code when it thinks it's the entry module.
declare module 'pdf-parse/lib/pdf-parse.js' {
  interface PdfParseResult {
    text: string
    numpages: number
  }
  function pdfParse(buffer: Buffer): Promise<PdfParseResult>
  export default pdfParse
}
