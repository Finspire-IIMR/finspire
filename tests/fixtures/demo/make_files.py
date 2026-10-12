#!/usr/bin/env python3
"""Writes the tiny demo files the Library test uses (tests/fixtures/demo/files/). Standard library only.
Run again after changing it:  python3 tests/fixtures/demo/make_files.py
Every file is clearly a sample for testing the viewer, not club material."""
import pathlib, struct, zlib, zipfile

OUT = pathlib.Path(__file__).resolve().parent / "files"


def esc(s):
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def pdf(path, pages, size=(595, 842)):
    """pages: list of lists of ops: ("t", x, y, size, bold, text) | ("r", x, y, w, h, gray) | ("l", x1, y1, x2, y2)"""
    W, H = size
    objs = {}
    n_pages = len(pages)
    # 1 catalog, 2 pages, 3 font regular, 4 font bold, then (page, content) pairs
    objs[1] = b"<< /Type /Catalog /Pages 2 0 R >>"
    kids = " ".join(f"{5 + 2 * i} 0 R" for i in range(n_pages))
    objs[2] = f"<< /Type /Pages /Kids [{kids}] /Count {n_pages} >>".encode()
    objs[3] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
    objs[4] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"
    for i, ops in enumerate(pages):
        cs = []
        for op in ops:
            if op[0] == "t":
                _, x, y, sz, bold, text = op
                cs.append(f"BT /{'F2' if bold else 'F1'} {sz} Tf {x} {y} Td ({esc(text)}) Tj ET")
            elif op[0] == "r":
                _, x, y, w, h, g = op
                cs.append(f"{g} g {x} {y} {w} {h} re f 0 g")
            elif op[0] == "c":
                _, x, y, w, h, r, gg, b = op
                cs.append(f"{r} {gg} {b} rg {x} {y} {w} {h} re f 0 g")
            elif op[0] == "l":
                _, x1, y1, x2, y2 = op
                cs.append(f"0.8 G 0.8 w {x1} {y1} m {x2} {y2} l S 0 G")
        data = zlib.compress("\n".join(cs).encode("cp1252"))
        objs[6 + 2 * i] = b"<< /Length %d /Filter /FlateDecode >>\nstream\n" % len(data) + data + b"\nendstream"
        objs[5 + 2 * i] = (f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {W} {H}] "
                           f"/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents {6 + 2 * i} 0 R >>").encode()
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offs = {}
    for k in sorted(objs):
        offs[k] = len(out)
        out += f"{k} 0 obj\n".encode() + objs[k] + b"\nendobj\n"
    x = len(out)
    n = max(objs) + 1
    out += f"xref\n0 {n}\n0000000000 65535 f \n".encode()
    for k in range(1, n):
        out += f"{offs[k]:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {n} /Root 1 0 R >>\nstartxref\n{x}\n%%EOF\n".encode()
    path.write_bytes(bytes(out))


def notes_page(title, n, total, heading, lines, W=595, H=842):
    ops = [("c", 0, H - 6, W, 6, 0.86, 0.16, 0.19),
           ("t", 56, H - 64, 10, False, "FINSPIRE  -  SAMPLE FILE FOR TESTING THE LIBRARY VIEWER"),
           ("t", 56, H - 104, 24, True, title),
           ("l", 56, H - 124, W - 56, H - 124),
           ("t", 56, H - 164, 16, True, heading)]
    y = H - 196
    for ln in lines:
        if ln.startswith("# "):
            y -= 8
            ops.append(("t", 56, y, 13, True, ln[2:]))
        elif ln.startswith("= "):
            ops.append(("r", 56, y - 8, W - 112, 26, 0.94))
            ops.append(("t", 68, y, 12, True, ln[2:]))
            y -= 6
        else:
            ops.append(("t", 56, y, 12, False, ln))
        y -= 22
    ops.append(("l", 56, 60, W - 56, 60))
    ops.append(("t", 56, 42, 9, False, f"Page {n} of {total}"))
    return ops


def make_pdfs():
    cfa = [
        ("Time value of money", [
            "Money today is worth more than the same amount later, because it can earn a return.",
            "# Future value", "= FV = PV x (1 + r)^n",
            "PV is the amount today, r the rate per period and n the number of periods.",
            "# Present value", "= PV = FV / (1 + r)^n",
            "Discounting is compounding run backwards.",
            "# Worked example",
            "Rs 10,000 invested at 8% a year for 3 years grows to about Rs 12,597.",
        ]),
        ("Return measures", [
            "# Holding period return", "= HPR = (P1 - P0 + D1) / P0",
            "P0 is the starting price, P1 the ending price and D1 any income received.",
            "# Arithmetic and geometric mean",
            "The arithmetic mean averages returns; the geometric mean compounds them.",
            "Over several periods the geometric mean is never above the arithmetic mean.",
            "# Money- and time-weighted returns",
            "Time-weighted return removes the effect of cash flows in and out of a portfolio.",
        ]),
        ("Ethics: the six standards", [
            "I    Professionalism", "II   Integrity of capital markets", "III  Duties to clients",
            "IV   Duties to employers", "V    Investment analysis, recommendations and actions",
            "VI   Conflicts of interest",
            "# How to study them",
            "Read each standard with its examples, then try the practice questions.",
        ]),
    ]
    pages = [notes_page("Sample CFA notes", i + 1, len(cfa), h, l) for i, (h, l) in enumerate(cfa)]
    pdf(OUT / "sample-cfa-notes.pdf", pages)

    dcf = [("What a DCF does", ["A discounted cash flow model values a business by its future cash flows.",
                                "# Steps", "1. Forecast free cash flow", "2. Choose a discount rate (WACC)",
                                "3. Estimate a terminal value", "4. Discount everything to today"]),
           ("Free cash flow", ["= FCFF = EBIT(1 - t) + D&A - Capex - Change in NWC",
                               "Use the same definition every year of the forecast."]),
           ("Discount rate", ["= WACC = E/V x Re + D/V x Rd x (1 - t)",
                              "Re usually comes from CAPM: Rf + beta x equity risk premium."]),
           ("Terminal value", ["= TV = FCF(n+1) / (WACC - g)", "g must stay below the long-run growth of the economy."]),
           ("Checks", ["Compare the implied multiple with peers.", "Test how the value moves with WACC and g."])]
    pdf(OUT / "dcf-walkthrough.pdf", [notes_page("DCF walkthrough", i + 1, len(dcf), h, l) for i, (h, l) in enumerate(dcf)])

    guide = [("Exported from a Google Doc", ["In demo mode, Google Docs open as this PDF, the way the",
                                             "Library exports real Docs, Slides and Sheets to PDF.",
                                             "# Fit questions", "Walk me through your CV.", "Why finance?",
                                             "# Technical questions", "How do the three statements link?",
                                             "What happens to the statements if depreciation rises by 10?"])]
    pdf(OUT / "interview-guide-export.pdf", [notes_page("Interview guide", 1, 1, h, l) for h, l in guide])

    deck = [("Pitch structure", ["1. The idea in one line", "2. Business and industry", "3. Thesis: why the market is wrong",
                                 "4. Valuation", "5. Risks and what would change our mind"]),
            ("One-page model", ["Keep the model to one sheet: revenue, margins, cash flow, valuation."])]
    pdf(OUT / "pitch-deck-export.pdf", [notes_page("Stock pitch format", i + 1, len(deck), h, l, W=842, H=595)
                                        for i, (h, l) in enumerate(deck)], size=(842, 595))


def png(path, w, h, pixel):
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        for x in range(w):
            raw += bytes(pixel(x, y))
    def chunk(t, d):
        c = t + d
        return struct.pack(">I", len(d)) + c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) +
                     chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))


def make_png():
    W, H = 640, 360
    bars = [0.38, 0.52, 0.47, 0.66, 0.58, 0.74, 0.69, 0.86]
    bw = 44
    def px(x, y):
        bg = (24, 24, 30)
        if y in (300, 301) and 48 <= x < W - 48:
            return (70, 70, 80)
        for i, v in enumerate(bars):
            x0 = 72 + i * 64
            top = int(300 - v * 240)
            if x0 <= x < x0 + bw and top <= y < 300:
                return (219, 41, 48) if i == len(bars) - 1 else (92, 92, 104)
        if y % 60 == 0 and 48 <= x < W - 48 and y < 300:
            return (36, 36, 44)
        return bg
    png(OUT / "revenue-chart.png", W, H, px)


def make_docx():
    ct = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
          '<Default Extension="xml" ContentType="application/xml"/>'
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    doc = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
           '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
           '<w:p><w:r><w:t>Sample cover letter (test file for the Finspire Library).</w:t></w:r></w:p>'
           '</w:body></w:document>')
    with zipfile.ZipFile(OUT / "cover-letter-sample.docx", "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", ct)
        z.writestr("_rels/.rels", rels)
        z.writestr("word/document.xml", doc)


def make_txt():
    (OUT / "reading-list.txt").write_text(
        "Sample reading list (test file for the Finspire Library)\n\n"
        "1. A textbook on corporate finance\n2. A textbook on valuation\n3. The annual report of a company you follow\n")


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    make_pdfs(); make_png(); make_docx(); make_txt()
    for f in sorted(OUT.iterdir()):
        print(f"{f.name:32s} {f.stat().st_size:7d} bytes")
