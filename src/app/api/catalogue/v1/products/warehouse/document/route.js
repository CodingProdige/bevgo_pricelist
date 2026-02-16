import { NextResponse } from "next/server";
import { PNG } from "pngjs";
import zlib from "zlib";
import { getStorage, ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { db, app } from "@/lib/firebase";
import { collection, doc, getDoc, getDocs } from "firebase/firestore";

const is8 = (s) => /^\d{8}$/.test(String(s ?? "").trim());

const PAGE = { width: 595, height: 842, margin: 30 };
const PRODUCT_BLOCK_H = 46;
const VARIANT_BLOCK_H = 50;
const IMAGE_FETCH_TIMEOUT_MS = 1200;
const IMAGE_FETCH_BUDGET_MS = 2500;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const IMAGE_FETCH_CONCURRENCY = 16;
const storage = getStorage(app);

function escText(v) {
  return String(v ?? "")
    .replaceAll("\\", "\\\\")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)");
}

function primaryProductImageUrl(product) {
  const images = Array.isArray(product?.media?.images) ? [...product.media.images] : [];
  images.sort((a, b) => (Number(a?.position) || 0) - (Number(b?.position) || 0));
  const first = images.find((img) => String(img?.imageUrl || "").trim());
  return String(first?.imageUrl || "").trim() || null;
}

function variantBarcodeImageUrl(variant) {
  return String(variant?.barcodeImageUrl || "").trim() || null;
}

function reserveObject(store) {
  store.push(null);
  return store.length - 1;
}

function setObject(store, id, content) {
  store[id] = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
}

function addObject(store, content) {
  store.push(Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8"));
  return store.length - 1;
}

function makeStreamObject(dict, streamBuffer) {
  const head = Buffer.from(`<< ${dict} /Length ${streamBuffer.length} >>\nstream\n`, "utf8");
  const tail = Buffer.from("\nendstream", "utf8");
  return Buffer.concat([head, streamBuffer, tail]);
}

function buildPdf(objects, rootId) {
  const parts = [];
  const offsets = new Array(objects.length).fill(0);

  parts.push(Buffer.from("%PDF-1.4\n%\xFF\xFF\xFF\xFF\n", "binary"));
  let cursor = parts[0].length;

  for (let i = 1; i < objects.length; i++) {
    const obj = objects[i] || Buffer.from("<<>>", "utf8");
    const lead = Buffer.from(`${i} 0 obj\n`, "utf8");
    const tail = Buffer.from("\nendobj\n", "utf8");
    offsets[i] = cursor;
    parts.push(lead, obj, tail);
    cursor += lead.length + obj.length + tail.length;
  }

  const xrefStart = cursor;
  parts.push(Buffer.from(`xref\n0 ${objects.length}\n`, "utf8"));
  parts.push(Buffer.from("0000000000 65535 f \n", "utf8"));
  for (let i = 1; i < objects.length; i++) {
    parts.push(Buffer.from(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`, "utf8"));
  }
  parts.push(
    Buffer.from(
      `trailer\n<< /Size ${objects.length} /Root ${rootId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`,
      "utf8"
    )
  );

  return Buffer.concat(parts);
}

function parseJpegDimensions(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let off = 2;
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) {
      off++;
      continue;
    }
    const marker = buf[off + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    const len = (buf[off + 2] << 8) + buf[off + 3];
    if (len < 2 || off + 2 + len > buf.length) break;
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      const height = (buf[off + 5] << 8) + buf[off + 6];
      const width = (buf[off + 7] << 8) + buf[off + 8];
      return { width, height };
    }
    off += 2 + len;
  }
  return null;
}

function pngToRgbImageObject(pngBuffer, objects) {
  const png = PNG.sync.read(pngBuffer);
  const { width, height, data } = png;
  const rgb = Buffer.alloc(width * height * 3);
  let j = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = (Number(data[i + 3]) || 0) / 255;
    // Composite transparency onto white canvas to avoid black-fill artifacts in PDF renderers.
    rgb[j++] = Math.round(data[i] * a + 255 * (1 - a));
    rgb[j++] = Math.round(data[i + 1] * a + 255 * (1 - a));
    rgb[j++] = Math.round(data[i + 2] * a + 255 * (1 - a));
  }
  const compressed = zlib.deflateSync(rgb);
  return addObject(
    objects,
    makeStreamObject(
      `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`,
      compressed
    )
  );
}

function jpegToImageObject(jpegBuffer, objects) {
  const dim = parseJpegDimensions(jpegBuffer);
  if (!dim?.width || !dim?.height) return null;
  return addObject(
    objects,
    makeStreamObject(
      `/Type /XObject /Subtype /Image /Width ${dim.width} /Height ${dim.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`,
      jpegBuffer
    )
  );
}

function detectImageType(buf) {
  if (!buf || buf.length < 4) return null;
  const pngSig =
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47;
  if (pngSig) return "png";
  const jpgSig = buf[0] === 0xff && buf[1] === 0xd8;
  if (jpgSig) return "jpeg";
  return null;
}

async function fetchImageBuffer(url, deadlineTs) {
  const u = String(url || "").trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) return null;
  const now = Date.now();
  if (deadlineTs && now >= deadlineTs) return null;
  const remainingBudget = deadlineTs ? Math.max(1, deadlineTs - now) : IMAGE_FETCH_TIMEOUT_MS;
  const timeoutMs = Math.min(IMAGE_FETCH_TIMEOUT_MS, remainingBudget);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(u, { cache: "no-store", signal: controller.signal });
    if (!res.ok) return null;
    const len = Number(res.headers.get("content-length") || 0);
    if (len > MAX_IMAGE_BYTES) return null;
    const ab = await res.arrayBuffer();
    if (ab.byteLength > MAX_IMAGE_BYTES) return null;
    return Buffer.from(ab);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function mapWithConcurrency(items, limit, worker) {
  const out = new Array(items.length);
  let idx = 0;
  const n = Math.max(1, Number(limit) || 1);

  const runners = new Array(Math.min(n, items.length)).fill(0).map(async () => {
    while (true) {
      const i = idx;
      idx += 1;
      if (i >= items.length) break;
      out[i] = await worker(items[i], i);
    }
  });

  await Promise.all(runners);
  return out;
}

function imageObjectFromBuffer(buf, objects) {
  const kind = detectImageType(buf);
  if (kind === "png") return pngToRgbImageObject(buf, objects);
  if (kind === "jpeg") return jpegToImageObject(buf, objects);
  return null;
}

function addLine(cmds, x1, y1, x2, y2) {
  cmds.push(`${x1} ${y1} m ${x2} ${y2} l S`);
}

function addRect(cmds, x, y, w, h) {
  cmds.push(`${x} ${y} ${w} ${h} re S`);
}

function addFilledRect(cmds, x, y, w, h, gray = 0.95) {
  cmds.push(`q ${gray} g ${x} ${y} ${w} ${h} re f Q`);
  addRect(cmds, x, y, w, h);
}

function addText(cmds, x, y, size, text) {
  cmds.push(`BT /F1 ${size} Tf 1 0 0 1 ${x} ${y} Tm (${escText(text)}) Tj ET`);
}

function newPageState(title) {
  const page = { cmds: [], xobjects: [], y: PAGE.height - PAGE.margin - 24 };
  addText(page.cmds, PAGE.margin, PAGE.height - PAGE.margin + 2, 16, title);
  addText(
    page.cmds,
    PAGE.width - 210,
    PAGE.height - PAGE.margin + 2,
    9,
    `Generated: ${new Date().toISOString()}`
  );
  addLine(page.cmds, PAGE.margin, PAGE.height - PAGE.margin - 4, PAGE.width - PAGE.margin, PAGE.height - PAGE.margin - 4);
  const noticeY = PAGE.height - PAGE.margin - 30;
  addRect(page.cmds, PAGE.margin, noticeY - 14, PAGE.width - PAGE.margin * 2, 18);
  addText(page.cmds, PAGE.margin + 8, noticeY - 2, 9, "WAREHOUSE PICK DOCUMENT");
  page.y = noticeY - 24;
  return page;
}

function ensureSpace(state, pages, need, title) {
  if (state.y - need >= PAGE.margin) return state;
  pages.push(state);
  return newPageState(title);
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const uniqueId = String(searchParams.get("unique_id") || "").trim();
    const activeOnly = String(searchParams.get("active_only") || "false").toLowerCase() === "true";
    const maxProductsRaw = Number.parseInt(String(searchParams.get("max_products") || "").trim(), 10);
    const maxProducts = Number.isFinite(maxProductsRaw) && maxProductsRaw > 0 ? maxProductsRaw : null;
  const title = uniqueId ? "Warehouse Product Sheet" : "Warehouse Product Catalogue";

    let products = [];
    if (uniqueId) {
      if (!is8(uniqueId)) {
        return NextResponse.json(
          { ok: false, title: "Invalid Product ID", message: "'unique_id' must be an 8-digit string." },
          { status: 400 }
        );
      }
      const snap = await getDoc(doc(db, "products_v2", uniqueId));
      if (snap.exists()) products = [{ docId: snap.id, ...(snap.data() || {}) }];
    } else {
      const snap = await getDocs(collection(db, "products_v2"));
      products = snap.docs.map((d) => ({ docId: d.id, ...(d.data() || {}) }));
    }

    products = products
      .filter((p) => (activeOnly ? p?.placement?.isActive !== false : true))
      .sort((a, b) => {
        const ac = String(a?.grouping?.category || "").localeCompare(String(b?.grouping?.category || ""));
        if (ac !== 0) return ac;
        const ab = String(a?.grouping?.brand || "").localeCompare(String(b?.grouping?.brand || ""));
        if (ab !== 0) return ab;
        return (Number(a?.placement?.position) || 0) - (Number(b?.placement?.position) || 0);
      });
    if (maxProducts) products = products.slice(0, maxProducts);

    // Gather URLs and fetch with a hard global time budget.
    const barcodeUrls = new Set();
    const productUrls = new Set();
    const productImageUrlByKey = new Map();
    const variantBarcodeUrlByKey = new Map();
    for (const product of products) {
      const pKey = String(product?.docId || product?.product?.unique_id || "");
      const pImg = primaryProductImageUrl(product);
      if (pKey) productImageUrlByKey.set(pKey, pImg);
      if (pImg) productUrls.add(pImg);
      const variants = Array.isArray(product?.variants) ? product.variants : [];
      for (const variant of variants) {
        const vKey = `${pKey}:${String(variant?.variant_id || "")}`;
        const bUrl = variantBarcodeImageUrl(variant);
        variantBarcodeUrlByKey.set(vKey, bUrl);
        if (bUrl) barcodeUrls.add(bUrl);
      }
    }

    const deadlineTs = Date.now() + IMAGE_FETCH_BUDGET_MS;
    const imageBufferByUrl = new Map();
    // Prioritize barcodes, then product images.
    const prioritizedUrls = [...barcodeUrls, ...[...productUrls].filter((u) => !barcodeUrls.has(u))];
    const fetchedImages = await mapWithConcurrency(
      prioritizedUrls,
      IMAGE_FETCH_CONCURRENCY,
      async (url) => ({ url, buf: await fetchImageBuffer(url, deadlineTs) })
    );
    for (const row of fetchedImages) {
      if (!row?.url) continue;
      imageBufferByUrl.set(row.url, row.buf || null);
    }
    const requestedImageCount = prioritizedUrls.length;
    const fetchedImageCount = [...imageBufferByUrl.values()].filter(Boolean).length;

    const objects = [null];
    const pagesId = reserveObject(objects);
    const catalogId = reserveObject(objects);
    const fontId = addObject(objects, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

    const pages = [];
    let state = newPageState(title);

    let lastCategory = null;
    let lastBrand = null;
    for (let pIdx = 0; pIdx < products.length; pIdx++) {
      const product = products[pIdx];
      const p = product?.product || {};
      const g = product?.grouping || {};
      const variants = (Array.isArray(product?.variants) ? product.variants : []).sort(
        (a, b) => (Number(a?.placement?.position) || 0) - (Number(b?.placement?.position) || 0)
      );

      const cat = String(g?.category || "uncategorized");
      const brand = String(g?.brand || "unbranded");
      if (cat !== lastCategory || brand !== lastBrand) {
        state = ensureSpace(state, pages, 20, title);
        addFilledRect(state.cmds, PAGE.margin, state.y - 14, PAGE.width - PAGE.margin * 2, 16, 0.92);
        addText(state.cmds, PAGE.margin + 8, state.y - 3, 9, `Category: ${cat}  |  Brand: ${brand}`);
        state.y -= 18;
        lastCategory = cat;
        lastBrand = brand;
      }

      state = ensureSpace(state, pages, PRODUCT_BLOCK_H + 8, title);
      const pTop = state.y;
      const pBottom = pTop - PRODUCT_BLOCK_H;
      const colIndexW = 26;
      const colImageW = 56;
      const x0 = PAGE.margin;
      const x1 = x0 + colIndexW;
      const x2 = x1 + colImageW;
      const x3 = PAGE.width - PAGE.margin;
      addFilledRect(state.cmds, x0, pBottom, x3 - x0, PRODUCT_BLOCK_H, 0.97);
      addLine(state.cmds, x1, pBottom, x1, pTop);
      addLine(state.cmds, x2, pBottom, x2, pTop);

      const productKey = String(product?.docId || product?.product?.unique_id || "");
      const pImgUrl = productImageUrlByKey.get(productKey) || null;
      const pImgBuf = pImgUrl ? imageBufferByUrl.get(pImgUrl) || null : null;
      if (pImgBuf) {
        const pImgRef = imageObjectFromBuffer(pImgBuf, objects);
        if (pImgRef) {
          const name = `Im${objects.length}_${Math.random().toString(36).slice(2, 6)}`;
          state.xobjects.push({ name, ref: pImgRef });
          const iw = colImageW - 12;
          const ih = PRODUCT_BLOCK_H - 12;
          const ix = x1 + 6;
          const iy = pBottom + 6;
          state.cmds.push(`q ${iw} 0 0 ${ih} ${ix} ${iy} cm /${name} Do Q`);
        }
      }

      addText(state.cmds, x0 + 9, pBottom + PRODUCT_BLOCK_H / 2, 9, String(pIdx + 1));
      addText(state.cmds, x2 + 8, pTop - 18, 11, p?.title || "Untitled Product");
      state.y = pBottom - 8;

      if (!variants.length) {
        state = ensureSpace(state, pages, 20, title);
        addText(state.cmds, PAGE.margin + 4, state.y, 9, "No variants found.");
        state.y -= 16;
        continue;
      }

      for (const variant of variants) {
        state = ensureSpace(state, pages, VARIANT_BLOCK_H + 6, title);

        const top = state.y;
        const blockY = top - VARIANT_BLOCK_H;
        const rightW = 130;
        addRect(state.cmds, PAGE.margin, blockY, PAGE.width - PAGE.margin * 2, VARIANT_BLOCK_H);
        addLine(state.cmds, PAGE.width - PAGE.margin - rightW, blockY, PAGE.width - PAGE.margin - rightW, top);

        const variantKey = `${productKey}:${String(variant?.variant_id || "")}`;
        const barcodeUrl = variantBarcodeUrlByKey.get(variantKey) || null;
        const barcodePng = barcodeUrl ? imageBufferByUrl.get(barcodeUrl) || null : null;
        const barcodeLeft = PAGE.width - PAGE.margin - rightW + 8;
        const barcodeBottom = blockY + 8;
        const barcodeW = rightW - 16;
        const barcodeH = VARIANT_BLOCK_H - 16;
        if (barcodePng) {
          const imageRef = pngToRgbImageObject(barcodePng, objects);
          const imageName = `Im${objects.length}_${Math.random().toString(36).slice(2, 6)}`;
          state.xobjects.push({ name: imageName, ref: imageRef });
          state.cmds.push(`q ${barcodeW} 0 0 ${barcodeH} ${barcodeLeft} ${barcodeBottom} cm /${imageName} Do Q`);
        } else {
          addText(state.cmds, barcodeLeft + 10, blockY + VARIANT_BLOCK_H / 2, 8, "No barcode");
        }

        const x = PAGE.margin + 8;
        let y = top - 16;
        addText(state.cmds, x, y, 10, variant?.label || "Untitled Variant");
        y -= 13;
        addText(
          state.cmds,
          x,
          y,
          9,
          `Pack size: ${variant?.pack?.unit_count ?? "-"} x ${variant?.pack?.volume ?? "-"} ${variant?.pack?.volume_unit ?? ""}`
        );

        state.y = blockY - 6;
      }
    }

    pages.push(state);

    const pageRefs = [];
    for (const page of pages) {
      const contentRef = addObject(objects, makeStreamObject("", Buffer.from(page.cmds.join("\n"), "utf8")));
      const xObjectDict = page.xobjects.length
        ? `/XObject << ${page.xobjects.map((xo) => `/${xo.name} ${xo.ref} 0 R`).join(" ")} >>`
        : "";
      const resources = `<< /Font << /F1 ${fontId} 0 R >> ${xObjectDict} >>`;
      const pageRef = addObject(
        objects,
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Resources ${resources} /Contents ${contentRef} 0 R >>`
      );
      pageRefs.push(pageRef);
    }

    setObject(objects, pagesId, `<< /Type /Pages /Kids [${pageRefs.map((r) => `${r} 0 R`).join(" ")}] /Count ${pageRefs.length} >>`);
    setObject(objects, catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

    const pdf = buildPdf(objects, catalogId);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const baseName = uniqueId ? `warehouse-sheet-${uniqueId}` : "warehouse-catalogue";
    const filePath = `warehouse/documents/${baseName}-${stamp}.pdf`;
    const fileRef = ref(storage, filePath);
    await uploadBytes(fileRef, pdf, { contentType: "application/pdf" });
    const pdfUrl = await getDownloadURL(fileRef);

    return NextResponse.json({
      ok: true,
      message: "Warehouse PDF generated.",
      data: {
        pdfUrl,
        storage_path: filePath,
        generatedAt: new Date().toISOString(),
        total_products: products.length,
        image_fetch_timeout_ms: IMAGE_FETCH_TIMEOUT_MS,
        image_fetch_budget_ms: IMAGE_FETCH_BUDGET_MS,
        image_urls_requested: requestedImageCount,
        image_urls_loaded: fetchedImageCount
      }
    });
  } catch (e) {
    console.error("[warehouse/document] failed:", e);
    return NextResponse.json(
      { ok: false, title: "Unexpected Error", message: "Failed to generate warehouse PDF." },
      { status: 500 }
    );
  }
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
