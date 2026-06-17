declare module "pdf-parse" {
  export default function pdfParse(dataBuffer: Buffer): Promise<{ text: string; numpages?: number }>;
}
