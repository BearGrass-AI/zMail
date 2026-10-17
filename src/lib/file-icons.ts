// Lucide icon for an attachment or Drive file, from its MIME type and name.

import { File, FileArchive, FileImage, FileSpreadsheet, FileText, Presentation } from "lucide-react";

export function fileIcon(mime: string, name: string) {
  if (mime.startsWith("image/")) return FileImage;
  if (/pdf|word|text|rtf/.test(mime)) return FileText;
  if (/sheet|excel|csv/.test(mime) || /\.(xlsx?|csv)$/i.test(name)) return FileSpreadsheet;
  if (/presentation|powerpoint/.test(mime) || /\.pptx?$/i.test(name)) return Presentation;
  if (/zip|compressed|tar/.test(mime)) return FileArchive;
  return File;
}
