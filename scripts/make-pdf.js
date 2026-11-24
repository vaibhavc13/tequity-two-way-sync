import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { marked } from 'marked';

const cwd = process.cwd();
const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

function convertMarkdownToPdf(mdFileName, pdfFileName, title) {
  const mdPath = path.join(cwd, mdFileName);
  const outHtmlPath = path.join(cwd, 'dist', `${path.basename(mdFileName, '.md')}_print.html`);
  const outPdfPath = path.join(cwd, pdfFileName);

  if (!fs.existsSync(mdPath)) {
    console.error(`File not found: ${mdPath}`);
    return;
  }

  const md = fs.readFileSync(mdPath, 'utf-8');
  const bodyHtml = marked.parse(md);

  const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <style>
    @page {
      margin: 18mm 15mm 18mm 15mm;
      size: A4 portrait;
      @bottom-right {
        content: counter(page);
      }
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #1e293b;
      line-height: 1.55;
      font-size: 11pt;
      margin: 0;
      padding: 0;
    }
    h1 {
      color: #0f172a;
      font-size: 20pt;
      border-bottom: 2px solid #0284c7;
      padding-bottom: 8px;
      margin-top: 0;
      margin-bottom: 12px;
    }
    h2 {
      color: #0369a1;
      font-size: 14pt;
      border-bottom: 1px solid #cbd5e1;
      padding-bottom: 5px;
      margin-top: 22pt;
      page-break-after: avoid;
    }
    h3 {
      color: #0f172a;
      font-size: 12pt;
      margin-top: 14pt;
      page-break-after: avoid;
    }
    p, li {
      color: #334155;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 12pt 0;
      font-size: 9.5pt;
      page-break-inside: avoid;
    }
    th, td {
      border: 1px solid #cbd5e1;
      padding: 6pt 8pt;
      text-align: left;
    }
    th {
      background-color: #f1f5f9;
      color: #0f172a;
      font-weight: 600;
    }
    pre {
      background-color: #f8fafc;
      border: 1px solid #e2e8f0;
      border-left: 3px solid #0284c7;
      padding: 10pt;
      border-radius: 4px;
      font-family: Consolas, "Courier New", monospace;
      font-size: 9pt;
      line-height: 1.4;
      overflow-x: auto;
      page-break-inside: avoid;
    }
    code {
      font-family: Consolas, "Courier New", monospace;
      font-size: 9.5pt;
      background: #f1f5f9;
      padding: 1px 4px;
      border-radius: 3px;
      color: #0369a1;
    }
    pre code {
      background: none;
      padding: 0;
      color: #0f172a;
    }
    blockquote {
      border-left: 3px solid #0284c7;
      margin: 10pt 0;
      padding-left: 12pt;
      color: #475569;
      font-style: italic;
    }
    hr {
      border: 0;
      border-top: 1px solid #e2e8f0;
      margin: 20pt 0;
    }
  </style>
</head>
<body>
  ${bodyHtml}
</body>
</html>`;

  if (!fs.existsSync(path.join(cwd, 'dist'))) {
    fs.mkdirSync(path.join(cwd, 'dist'), { recursive: true });
  }
  fs.writeFileSync(outHtmlPath, fullHtml, 'utf-8');

  const fileUrl = 'file:///' + outHtmlPath.replace(/\\/g, '/');
  const cmd = `"${edgePath}" --headless --disable-gpu --run-all-compositor-stages-before-draw --print-to-pdf="${outPdfPath}" "${fileUrl}"`;
  execSync(cmd);
  console.log(`Generated: ${pdfFileName}`);
}

convertMarkdownToPdf('DESIGN.md', 'DESIGN.pdf', 'Tequity Two-Way Sync Design Document');
convertMarkdownToPdf('README.md', 'README.pdf', 'Tequity Two-Way Sync System Overview');
