import JSZip from "jszip";

/**
 * A minimal real .docx carrying a `javascript:` hyperlink, an external https hyperlink and bold
 * text — the smallest document that proves mammoth passes a document's own links through
 * unsanitised. Built in-process so the e2e needs no python or binary fixture.
 */
export async function buildHostileDocx(jsUrl, httpUrl) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.folder("_rels").file(".rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  const word = zip.folder("word");
  word.folder("_rels").file("document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rLink1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${jsUrl}" TargetMode="External"/>
<Relationship Id="rLink2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${httpUrl}" TargetMode="External"/>
</Relationships>`);
  word.file("document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Quarterly report</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Plain text with </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>bold</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Evil: </w:t></w:r><w:hyperlink r:id="rLink1"><w:r><w:t>click me</w:t></w:r></w:hyperlink></w:p>
<w:p><w:r><w:t xml:space="preserve">Site: </w:t></w:r><w:hyperlink r:id="rLink2"><w:r><w:t>example site</w:t></w:r></w:hyperlink></w:p>
</w:body></w:document>`);
  return Buffer.from(await zip.generateAsync({ type: "uint8array" }));
}
