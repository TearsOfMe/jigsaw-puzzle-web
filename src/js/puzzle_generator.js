/**
 * Flood-Fill Pixel Scanner & Alpha-Mask Stamping Engine
 *
 * - Scans any image containing puzzle piece silhouettes via 4-connected BFS Flood Fill
 * - Isolates every single puzzle piece pixel-accurately as an individual Alpha Mask
 * - Uses ZERO mathematical Bézier curves (no bezierCurveTo / quadraticCurveTo)
 * - Stamps out the puzzle motif image via ctx.globalCompositeOperation = 'source-in'
 * - Provides O(1) pixel-accurate hit detection via the scanned alpha values of each mask
 */

class SilhouetteScanner {
    static _cache = new Map();
    static _scratchCanvas = null;
    static _baseScratch = null;
    static _shadowScratch = null;
    static _isLittleEndian = (() => {
        const buf = new ArrayBuffer(4);
        new Uint8Array(buf)[0] = 0x0a;
        return new Uint32Array(buf)[0] === 0x0a;
    })();

    static getTemplateUrl(rows, cols) {
        if (!rows || !cols || (rows === 9 && cols === 10)) {
            return 'assets/silhouettes/silhouette.png?v=stanz3';
        }
        return `assets/silhouettes/silhouettes_${rows}x${cols}.png?v=stanz3`;
    }

    /**
     * Loads a silhouette image URL (or DataURL) and runs the Flood-Fill Pixel Scanner.
     */
    static loadAndScan(url, forceRescan = false) {
        if (!forceRescan && SilhouetteScanner._cache.has(url)) {
            return Promise.resolve(SilhouetteScanner._cache.get(url));
        }

        return new Promise((resolve, reject) => {
            const img = new Image();
            if (!url.startsWith('data:')) {
                img.crossOrigin = 'anonymous';
            }
            img.onload = () => {
                try {
                    const result = SilhouetteScanner.scanImage(img);
                    if (!url.startsWith('data:')) {
                        SilhouetteScanner._cache.set(url, result);
                    }
                    resolve(result);
                } catch (err) {
                    reject(err);
                }
            };
            img.onerror = () => reject(new Error(`Konnte Silhouetten-Bild nicht laden: ${url}`));
            img.src = url;
        });
    }

    /**
     * Flood-Fill Pixel Scanner:
     * Reads an image with puzzle piece silhouettes onto an offscreen canvas,
     * detects every piece via pixel-level BFS Flood Fill, and extracts each piece
     * individually as a pixel-exact Alpha Mask (Uint8Array + HTMLCanvasElement).
     */
    static scanImage(img) {
        const t0 = performance.now();
        // 1600px max scan dimension matches iPad Retina board resolution while scanning 2.3x faster
        const maxScanDim = 1600;
        let W = img.naturalWidth || img.width;
        let H = img.naturalHeight || img.height;

        if (W > maxScanDim || H > maxScanDim) {
            const ratio = Math.min(maxScanDim / W, maxScanDim / H);
            W = Math.max(1, Math.round(W * ratio));
            H = Math.max(1, Math.round(H * ratio));
        }

        const scanCanvas = document.createElement('canvas');
        scanCanvas.width = W;
        scanCanvas.height = H;
        const scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true });
        scanCtx.drawImage(img, 0, 0, W, H);

        const rgba = scanCtx.getImageData(0, 0, W, H).data;
        const totalPixels = W * H;

        // 1. Auto-detect background vs. silhouette foreground from image perimeter
        const { fgAlpha, fgCount } = SilhouetteScanner._computeForegroundAlpha(rgba, W, H);

        const minArea = Math.max(48, Math.floor(totalPixels * 0.00012));
        let components = [];
        let ownerId = null;
        let effectiveAlpha = fgAlpha;
        let isCutLineSheet = false;
        let stanzbogenGrid = null;
        let pixelNeighbors = null;

        const tryStanzbogenScan = () => {
            const invAlpha = new Uint8Array(totalPixels);
            for (let i = 0; i < totalPixels; i++) {
                invAlpha[i] = 255 - fgAlpha[i];
            }
            // High threshold (150) prevents bleeding across anti-aliased grey cut-line fringes
            const invResult = SilhouetteScanner._floodFillIslands(invAlpha, W, H, minArea, 150);

            // Exclude outer margin component(s) wrapping around the puzzle frame
            const interiorComps = invResult.components.filter(
                c => !((c.minX === 0 && c.maxX === W - 1) || (c.minY === 0 && c.maxY === H - 1))
            );
            const chosenComps = interiorComps.length >= 2 ? interiorComps : invResult.components;
            if (chosenComps.length < 2) return false;

            isCutLineSheet = true;
            let maxCid = 0;
            for (let i = 0; i < chosenComps.length; i++) {
                if (chosenComps[i].id > maxCid) maxCid = chosenComps[i].id;
            }
            const validFlags = new Uint8Array(maxCid + 1);
            let frameMinX = W, frameMinY = H, frameMaxX = 0, frameMaxY = 0;
            for (let i = 0; i < chosenComps.length; i++) {
                const c = chosenComps[i];
                validFlags[c.id] = 1;
                if (c.minX < frameMinX) frameMinX = c.minX;
                if (c.minY < frameMinY) frameMinY = c.minY;
                if (c.maxX > frameMaxX) frameMaxX = c.maxX;
                if (c.maxY > frameMaxY) frameMaxY = c.maxY;
            }

            // Mark pixels outside the inner frame as -3 (forbidden outside region)
            // and cut-line pixels inside the frame as -1 so Voronoi partitions 100% of the puzzle rectangle
            const oid = invResult.ownerId;
            for (let y = 0; y < H; y++) {
                const rowOff = y * W;
                const inY = (y >= frameMinY && y <= frameMaxY);
                for (let x = 0; x < W; x++) {
                    const idx = rowOff + x;
                    if (!inY || x < frameMinX || x > frameMaxX) {
                        oid[idx] = -3;
                    } else {
                        const cur = oid[idx];
                        if (cur < 0 || cur > maxCid || validFlags[cur] === 0) {
                            oid[idx] = -1;
                        }
                    }
                }
            }

            SilhouetteScanner._dilateIntoCutLines(oid, chosenComps, W, H, maxCid);

            // Count exact rows & cols from top/left frame borders + true shared-edge neighbors
            const topSet = new Set();
            for (let x = frameMinX; x <= frameMaxX; x++) {
                const cid = oid[frameMinY * W + x];
                if (cid >= 0) topSet.add(cid);
            }
            const leftSet = new Set();
            for (let y = frameMinY; y <= frameMaxY; y++) {
                const cid = oid[y * W + frameMinX];
                if (cid >= 0) leftSet.add(cid);
            }
            if (topSet.size >= 1 && leftSet.size >= 1) {
                stanzbogenGrid = { rows: leftSet.size, cols: topSet.size };
            }

            pixelNeighbors = SilhouetteScanner._extractPixelNeighbors(
                oid, frameMinX, frameMinY, frameMaxX, frameMaxY, W
            );

            const fullOpaque = new Uint8Array(totalPixels);
            fullOpaque.fill(255);
            components = chosenComps;
            ownerId = oid;
            effectiveAlpha = fullOpaque;
            return true;
        };

        // Fast-path: Stanzbogen sheets have thin cut-lines (< 28% foreground coverage) -> skip redundant 1st BFS pass!
        const likelyCutLineSheet = fgCount < totalPixels * 0.28;
        if (likelyCutLineSheet) {
            if (!tryStanzbogenScan()) {
                const isl = SilhouetteScanner._floodFillIslands(fgAlpha, W, H, minArea, 14);
                components = isl.components;
                ownerId = isl.ownerId;
                effectiveAlpha = isl.effectiveAlpha;
            }
        } else {
            const isl = SilhouetteScanner._floodFillIslands(fgAlpha, W, H, minArea, 14);
            components = isl.components;
            ownerId = isl.ownerId;
            effectiveAlpha = isl.effectiveAlpha;
            if (components.length <= 1) {
                tryStanzbogenScan();
            }
        }

        if (components.length === 0) {
            throw new Error('Keine Puzzleteil-Silhouetten im Bild erkannt.');
        }

        // 4. Extract individual Alpha Mask (Uint8Array + Offscreen Mask Canvas) per piece using 32-bit writes
        const isLE = SilhouetteScanner._isLittleEndian;
        const rawMasks = components.map((comp, idx) => {
            const maskW = comp.maxX - comp.minX + 1;
            const maskH = comp.maxY - comp.minY + 1;
            const maskAlpha = new Uint8Array(maskW * maskH);

            const maskCanvas = document.createElement('canvas');
            maskCanvas.width = maskW;
            maskCanvas.height = maskH;
            const mctx = maskCanvas.getContext('2d');
            const mImgData = mctx.createImageData(maskW, maskH);
            const mData32 = new Uint32Array(mImgData.data.buffer);

            const cid = comp.id;
            for (let ly = 0; ly < maskH; ly++) {
                const globalRowOffset = (comp.minY + ly) * W + comp.minX;
                const localRowOffset = ly * maskW;
                for (let lx = 0; lx < maskW; lx++) {
                    const gIdx = globalRowOffset + lx;
                    if (ownerId[gIdx] === cid) {
                        const a = effectiveAlpha[gIdx];
                        const lIdx = localRowOffset + lx;
                        maskAlpha[lIdx] = a;
                        mData32[lIdx] = isLE ? ((a << 24) | 0x00ffffff) : (0xffffff00 | a);
                    }
                }
            }

            mctx.putImageData(mImgData, 0, 0);

            return {
                compId: cid,
                scanIndex: idx,
                minX: comp.minX,
                minY: comp.minY,
                maxX: comp.maxX,
                maxY: comp.maxY,
                maskW,
                maskH,
                area: comp.area,
                cx: comp.sumX / comp.area,
                cy: comp.sumY / comp.area,
                maskAlpha,
                maskCanvas
            };
        });

        // 5. Reconstruct exact assembled board coordinates from the scanned silhouettes
        const layout = SilhouetteScanner._reconstructLayout(rawMasks, W, H, isCutLineSheet, stanzbogenGrid, pixelNeighbors);
        layout.scanDurationMs = Math.round((performance.now() - t0) * 10) / 10;

        return layout;
    }

    /**
     * Auto-detects background (transparent or solid color) from border pixels
     * and converts every pixel into a foreground silhouette alpha (0..255).
     */
    static _computeForegroundAlpha(rgba, W, H) {
        const samplesR = [];
        const samplesG = [];
        const samplesB = [];
        const samplesA = [];

        const stepX = Math.max(1, Math.floor(W / 60));
        const stepY = Math.max(1, Math.floor(H / 60));

        const pushPixel = (x, y) => {
            const p = (y * W + x) * 4;
            samplesR.push(rgba[p]);
            samplesG.push(rgba[p + 1]);
            samplesB.push(rgba[p + 2]);
            samplesA.push(rgba[p + 3]);
        };

        for (let x = 0; x < W; x += stepX) {
            pushPixel(x, 0);
            pushPixel(x, H - 1);
        }
        for (let y = 0; y < H; y += stepY) {
            pushPixel(0, y);
            pushPixel(W - 1, y);
        }

        const median = (arr) => {
            const s = arr.slice().sort((a, b) => a - b);
            return s[Math.floor(s.length / 2)];
        };

        const bgA = median(samplesA);
        const total = W * H;
        const fgAlpha = new Uint8Array(total);
        let fgCount = 0;

        // Case 1: Transparent PNG / SVG background -> use image alpha channel directly
        if (bgA < 64) {
            for (let i = 0; i < total; i++) {
                const a = rgba[i * 4 + 3];
                fgAlpha[i] = a;
                if (a >= 80) fgCount++;
            }
            return { fgAlpha, fgCount };
        }

        // Case 2: Opaque background (e.g. black silhouettes on white background, or vice versa)
        const bgR = median(samplesR);
        const bgG = median(samplesG);
        const bgB = median(samplesB);

        for (let i = 0; i < total; i++) {
            const p = i * 4;
            const a = rgba[p + 3];
            if (a < 16) {
                fgAlpha[i] = 0;
                continue;
            }
            const dr = Math.abs(rgba[p] - bgR);
            const dg = Math.abs(rgba[p + 1] - bgG);
            const db = Math.abs(rgba[p + 2] - bgB);
            const maxDiff = dr > dg ? (dr > db ? dr : db) : (dg > db ? dg : db);

            if (maxDiff <= 18) {
                fgAlpha[i] = 0;
            } else if (maxDiff >= 145) {
                fgAlpha[i] = 255;
                fgCount++;
            } else {
                const val = (((maxDiff - 18) * 255) / 127 + 0.5) | 0;
                fgAlpha[i] = val;
                if (val >= 80) fgCount++;
            }
        }

        return { fgAlpha, fgCount };
    }

    /**
     * High-speed TypedArray 4-connected BFS Flood Fill.
     */
    static _floodFillIslands(fgAlpha, W, H, minArea, expandThreshold = 14) {
        const seedThreshold = Math.max(80, expandThreshold);
        const total = W * H;
        const ownerId = new Int32Array(total);
        ownerId.fill(-1);
        const queue = new Int32Array(total);
        const components = [];
        let nextId = 0;

        for (let startIdx = 0; startIdx < total; startIdx++) {
            if (ownerId[startIdx] !== -1 || fgAlpha[startIdx] < seedThreshold) continue;

            const cid = nextId++;
            let qHead = 0;
            let qTail = 0;

            ownerId[startIdx] = cid;
            queue[qTail++] = startIdx;

            let minX = W, minY = H, maxX = 0, maxY = 0;
            let sumX = 0, sumY = 0;

            while (qHead < qTail) {
                const curr = queue[qHead++];
                const cx = curr % W;
                const cy = (curr / W) | 0;

                if (cx < minX) minX = cx;
                if (cx > maxX) maxX = cx;
                if (cy < minY) minY = cy;
                if (cy > maxY) maxY = cy;
                sumX += cx;
                sumY += cy;

                // 4-connected neighbors
                if (cx > 0) {
                    const left = curr - 1;
                    if (ownerId[left] === -1 && fgAlpha[left] >= expandThreshold) {
                        ownerId[left] = cid;
                        queue[qTail++] = left;
                    }
                }
                if (cx + 1 < W) {
                    const right = curr + 1;
                    if (ownerId[right] === -1 && fgAlpha[right] >= expandThreshold) {
                        ownerId[right] = cid;
                        queue[qTail++] = right;
                    }
                }
                if (cy > 0) {
                    const up = curr - W;
                    if (ownerId[up] === -1 && fgAlpha[up] >= expandThreshold) {
                        ownerId[up] = cid;
                        queue[qTail++] = up;
                    }
                }
                if (cy + 1 < H) {
                    const down = curr + W;
                    if (ownerId[down] === -1 && fgAlpha[down] >= expandThreshold) {
                        ownerId[down] = cid;
                        queue[qTail++] = down;
                    }
                }
            }

            const area = qTail;
            if (area >= minArea) {
                components.push({
                    id: cid,
                    minX,
                    minY,
                    maxX,
                    maxY,
                    area,
                    sumX,
                    sumY
                });
            } else {
                // Clear tiny dust speckle IDs
                for (let i = 0; i < qTail; i++) {
                    ownerId[queue[i]] = -2;
                }
            }
        }

        return { components, ownerId, effectiveAlpha: fgAlpha };
    }

    /**
     * Multi-source BFS Voronoi dilation to assign all cut-line pixels (-1) inside the
     * Stanzbogen puzzle frame to their closest adjacent piece island so pieces meet with 0px gap.
     */
    static _dilateIntoCutLines(ownerId, components, W, H, maxCid = 0) {
        const total = W * H;
        const queue = new Int32Array(total);
        let qHead = 0;
        let qTail = 0;

        if (!maxCid) {
            for (let i = 0; i < components.length; i++) {
                if (components[i].id > maxCid) maxCid = components[i].id;
            }
        }
        const compArr = new Array(maxCid + 1);
        for (let i = 0; i < components.length; i++) {
            compArr[components[i].id] = components[i];
        }

        // Seed boundary pixels of all valid components adjacent to unclaimed (-1) cut-line pixels
        for (let idx = 0; idx < total; idx++) {
            const cid = ownerId[idx];
            if (cid < 0) continue;
            const x = idx % W;
            const y = (idx / W) | 0;
            if ((x > 0 && ownerId[idx - 1] === -1) ||
                (x + 1 < W && ownerId[idx + 1] === -1) ||
                (y > 0 && ownerId[idx - W] === -1) ||
                (y + 1 < H && ownerId[idx + W] === -1)) {
                queue[qTail++] = idx;
            }
        }

        while (qHead < qTail) {
            const curr = queue[qHead++];
            const cid = ownerId[curr];
            const comp = compArr[cid];
            const cx = curr % W;
            const cy = (curr / W) | 0;

            if (cx > 0) {
                const nIdx = curr - 1;
                if (ownerId[nIdx] === -1) {
                    ownerId[nIdx] = cid;
                    const nx = cx - 1;
                    if (nx < comp.minX) comp.minX = nx;
                    comp.area++;
                    comp.sumX += nx;
                    comp.sumY += cy;
                    queue[qTail++] = nIdx;
                }
            }
            if (cx + 1 < W) {
                const nIdx = curr + 1;
                if (ownerId[nIdx] === -1) {
                    ownerId[nIdx] = cid;
                    const nx = cx + 1;
                    if (nx > comp.maxX) comp.maxX = nx;
                    comp.area++;
                    comp.sumX += nx;
                    comp.sumY += cy;
                    queue[qTail++] = nIdx;
                }
            }
            if (cy > 0) {
                const nIdx = curr - W;
                if (ownerId[nIdx] === -1) {
                    ownerId[nIdx] = cid;
                    const ny = cy - 1;
                    if (ny < comp.minY) comp.minY = ny;
                    comp.area++;
                    comp.sumX += cx;
                    comp.sumY += ny;
                    queue[qTail++] = nIdx;
                }
            }
            if (cy + 1 < H) {
                const nIdx = curr + W;
                if (ownerId[nIdx] === -1) {
                    ownerId[nIdx] = cid;
                    const ny = cy + 1;
                    if (ny > comp.maxY) comp.maxY = ny;
                    comp.area++;
                    comp.sumX += cx;
                    comp.sumY += ny;
                    queue[qTail++] = nIdx;
                }
            }
        }
    }

    /**
     * Counts shared 4-connected pixel contacts between Voronoi-partitioned pieces
     * so only true edge-sharing neighbors (>= 8 shared boundary pixels) snap together.
     */
    static _extractPixelNeighbors(ownerId, minX, minY, maxX, maxY, W) {
        const contactCounts = new Map();

        for (let y = minY; y <= maxY; y++) {
            const rowOff = y * W;
            for (let x = minX; x <= maxX; x++) {
                const idx = rowOff + x;
                const cid = ownerId[idx];
                if (cid < 0) continue;
                if (x < maxX) {
                    const b = ownerId[idx + 1];
                    if (b >= 0 && b !== cid) {
                        const lo = cid < b ? cid : b;
                        const hi = cid < b ? b : cid;
                        const key = lo * 65536 + hi;
                        contactCounts.set(key, (contactCounts.get(key) || 0) + 1);
                    }
                }
                if (y < maxY) {
                    const b = ownerId[idx + W];
                    if (b >= 0 && b !== cid) {
                        const lo = cid < b ? cid : b;
                        const hi = cid < b ? b : cid;
                        const key = lo * 65536 + hi;
                        contactCounts.set(key, (contactCounts.get(key) || 0) + 1);
                    }
                }
            }
        }

        const neighborMap = new Map();
        for (const [key, cnt] of contactCounts.entries()) {
            if (cnt >= 8) {
                const lo = (key / 65536) | 0;
                const hi = key % 65536;
                if (!neighborMap.has(lo)) neighborMap.set(lo, []);
                if (!neighborMap.has(hi)) neighborMap.set(hi, []);
                neighborMap.get(lo).push(hi);
                neighborMap.get(hi).push(lo);
            }
        }
        return neighborMap;
    }

    /**
     * Reconstructs the puzzle layout & exact assembled coordinates from the scanned masks.
     */
    static _reconstructLayout(masks, sheetW, sheetH, isCutLineSheet, stanzbogenGrid = null, pixelNeighbors = null) {
        const count = masks.length;
        const avgH = masks.reduce((s, m) => s + m.maskH, 0) / count;

        // Try grouping into rows by vertical centroid (cy)
        const byY = masks.slice().sort((a, b) => a.cy - b.cy);
        const rowsList = [];
        for (const m of byY) {
            const lastRow = rowsList[rowsList.length - 1];
            if (!lastRow) {
                rowsList.push([m]);
            } else {
                const rowMeanY = lastRow.reduce((s, x) => s + x.cy, 0) / lastRow.length;
                if (Math.abs(m.cy - rowMeanY) <= avgH * 0.46) {
                    lastRow.push(m);
                } else {
                    rowsList.push([m]);
                }
            }
        }

        const R = rowsList.length;
        const C = rowsList[0] ? rowsList[0].length : 0;
        const isUniformGrid = !isCutLineSheet && R >= 2 && C >= 2 && rowsList.every(r => r.length === C);

        if (isUniformGrid) {
            for (const row of rowsList) {
                row.sort((a, b) => a.cx - b.cx);
            }

            // Measure explosion gapX & gapY directly from the flat outer border corners
            const gapXSamples = [];
            for (const borderRowIdx of [0, R - 1]) {
                for (let c = 0; c < C - 1; c++) {
                    const pA = rowsList[borderRowIdx][c];
                    const pB = rowsList[borderRowIdx][c + 1];
                    for (const inset of [2, 3, 4]) {
                        const lyA = borderRowIdx === 0 ? Math.min(inset, pA.maskH - 1) : Math.max(0, pA.maskH - 1 - inset);
                        const lyB = borderRowIdx === 0 ? Math.min(inset, pB.maskH - 1) : Math.max(0, pB.maskH - 1 - inset);
                        const rightA = SilhouetteScanner._lastOpaqueX(pA, lyA);
                        const leftB = SilhouetteScanner._firstOpaqueX(pB, lyB);
                        if (rightA !== -1 && leftB !== -1) {
                            gapXSamples.push((pB.minX + leftB) - (pA.minX + rightA) - 1);
                        }
                    }
                }
            }

            const gapYSamples = [];
            for (const borderColIdx of [0, C - 1]) {
                for (let r = 0; r < R - 1; r++) {
                    const pA = rowsList[r][borderColIdx];
                    const pB = rowsList[r + 1][borderColIdx];
                    for (const inset of [2, 3, 4]) {
                        const lxA = borderColIdx === 0 ? Math.min(inset, pA.maskW - 1) : Math.max(0, pA.maskW - 1 - inset);
                        const lxB = borderColIdx === 0 ? Math.min(inset, pB.maskW - 1) : Math.max(0, pB.maskW - 1 - inset);
                        const botA = SilhouetteScanner._lastOpaqueY(pA, lxA);
                        const topB = SilhouetteScanner._firstOpaqueY(pB, lxB);
                        if (botA !== -1 && topB !== -1) {
                            gapYSamples.push((pB.minY + topB) - (pA.minY + botA) - 1);
                        }
                    }
                }
            }

            const medianInt = (arr) => {
                if (arr.length === 0) return -1;
                const s = arr.slice().sort((a, b) => a - b);
                return Math.round(s[Math.floor(s.length / 2)]);
            };

            const gapX = medianInt(gapXSamples);
            const gapY = medianInt(gapYSamples);

            if (gapX >= 0 && gapY >= 0) {
                const marginX = medianInt(rowsList.map(row => row[0].minX));
                const marginY = medianInt(rowsList[0].map(m => m.minY));

                const pieces = [];
                let minAX = Infinity, minAY = Infinity, maxAX = 0, maxAY = 0;

                for (let r = 0; r < R; r++) {
                    for (let c = 0; c < C; c++) {
                        const m = rowsList[r][c];
                        const ax = m.minX - marginX - c * gapX;
                        const ay = m.minY - marginY - r * gapY;
                        if (ax < minAX) minAX = ax;
                        if (ay < minAY) minAY = ay;
                        if (ax + m.maskW > maxAX) maxAX = ax + m.maskW;
                        if (ay + m.maskH > maxAY) maxAY = ay + m.maskH;

                        pieces.push({
                            id: r * C + c,
                            row: r,
                            col: c,
                            isBorder: (r === 0 || r === R - 1 || c === 0 || c === C - 1),
                            assembledX: ax,
                            assembledY: ay,
                            maskW: m.maskW,
                            maskH: m.maskH,
                            maskAlpha: m.maskAlpha,
                            maskCanvas: m.maskCanvas,
                            neighbors: []
                        });
                    }
                }

                // Shift if needed so assembled origin is strictly (0, 0)
                if (minAX >= -10 && minAY >= -10) {
                    for (const p of pieces) {
                        p.assembledX -= minAX;
                        p.assembledY -= minAY;
                        const { row: r, col: c } = p;
                        if (r > 0) p.neighbors.push((r - 1) * C + c);
                        if (r < R - 1) p.neighbors.push((r + 1) * C + c);
                        if (c > 0) p.neighbors.push(r * C + (c - 1));
                        if (c < C - 1) p.neighbors.push(r * C + (c + 1));
                    }

                    return {
                        mode: 'exploded-grid',
                        rows: R,
                        cols: C,
                        assembledWidth: maxAX - minAX,
                        assembledHeight: maxAY - minAY,
                        pieces
                    };
                }
            }
        }

        // General layout (Stanzbogen cut-line sheet OR freeform / scattered silhouette sheet)
        let overallMinX = Infinity, overallMinY = Infinity;
        let overallMaxX = 0, overallMaxY = 0;
        for (const m of masks) {
            if (m.minX < overallMinX) overallMinX = m.minX;
            if (m.minY < overallMinY) overallMinY = m.minY;
            if (m.maxX + 1 > overallMaxX) overallMaxX = m.maxX + 1;
            if (m.maxY + 1 > overallMaxY) overallMaxY = m.maxY + 1;
        }

        const assembledWidth = Math.max(1, overallMaxX - overallMinX);
        const assembledHeight = Math.max(1, overallMaxY - overallMinY);
        const approxCols = (stanzbogenGrid && stanzbogenGrid.cols)
            ? stanzbogenGrid.cols
            : Math.max(1, Math.round(Math.sqrt(count * (assembledWidth / assembledHeight))));
        const approxRows = (stanzbogenGrid && stanzbogenGrid.rows)
            ? stanzbogenGrid.rows
            : Math.max(1, Math.ceil(count / approxCols));

        // Sort top-to-bottom, left-to-right for deterministic piece IDs
        const sorted = masks.slice().sort((a, b) => (Math.abs(a.cy - b.cy) > avgH * 0.4 ? a.cy - b.cy : a.cx - b.cx));
        const compIdToPieceId = new Map();

        const pieces = sorted.map((m, idx) => {
            compIdToPieceId.set(m.compId, idx);
            const ax = m.minX - overallMinX;
            const ay = m.minY - overallMinY;
            const borderTol = 6;
            const isBorder = (
                ax <= borderTol ||
                ay <= borderTol ||
                ax + m.maskW >= assembledWidth - borderTol ||
                ay + m.maskH >= assembledHeight - borderTol
            );
            return {
                compId: m.compId,
                id: idx,
                row: Math.floor(idx / approxCols),
                col: idx % approxCols,
                isBorder,
                assembledX: ax,
                assembledY: ay,
                maskW: m.maskW,
                maskH: m.maskH,
                maskAlpha: m.maskAlpha,
                maskCanvas: m.maskCanvas,
                neighbors: []
            };
        });

        if (pixelNeighbors) {
            for (const p of pieces) {
                const rawNbrs = pixelNeighbors.get(p.compId) || [];
                for (const nCompId of rawNbrs) {
                    const nPid = compIdToPieceId.get(nCompId);
                    if (nPid !== undefined) {
                        p.neighbors.push(nPid);
                    }
                }
            }
        } else {
            // Detect geometric neighbors from bounding box overlap / proximity
            const prox = 8;
            for (let i = 0; i < pieces.length; i++) {
                for (let j = i + 1; j < pieces.length; j++) {
                    const a = pieces[i];
                    const b = pieces[j];
                    const overlapX = a.assembledX - prox <= b.assembledX + b.maskW && a.assembledX + a.maskW + prox >= b.assembledX;
                    const overlapY = a.assembledY - prox <= b.assembledY + b.maskH && a.assembledY + a.maskH + prox >= b.assembledY;
                    if (overlapX && overlapY) {
                        a.neighbors.push(b.id);
                        b.neighbors.push(a.id);
                    }
                }
            }
        }

        return {
            mode: isCutLineSheet ? 'stanzbogen' : 'freeform',
            rows: approxRows,
            cols: approxCols,
            assembledWidth,
            assembledHeight,
            pieces
        };
    }

    static _firstOpaqueX(m, ly) {
        const off = ly * m.maskW;
        for (let x = 0; x < m.maskW; x++) {
            if (m.maskAlpha[off + x] >= 128) return x;
        }
        return -1;
    }

    static _lastOpaqueX(m, ly) {
        const off = ly * m.maskW;
        for (let x = m.maskW - 1; x >= 0; x--) {
            if (m.maskAlpha[off + x] >= 128) return x;
        }
        return -1;
    }

    static _firstOpaqueY(m, lx) {
        for (let y = 0; y < m.maskH; y++) {
            if (m.maskAlpha[y * m.maskW + lx] >= 128) return y;
        }
        return -1;
    }

    static _lastOpaqueY(m, lx) {
        for (let y = m.maskH - 1; y >= 0; y--) {
            if (m.maskAlpha[y * m.maskW + lx] >= 128) return y;
        }
        return -1;
    }

    /**
     * Stamps out the puzzle motif image for a single piece using ONLY its scanned Alpha Mask
     * via ctx.globalCompositeOperation = 'source-in' (zero Bézier curves!) and pre-bakes
     * the tactile drop shadow into looseCanvas so runtime rendering needs ZERO ctx.shadowBlur!
     */
    static stampPieceWithMask(piece, boardMotifCanvas, px0, py0, stampPxW, stampPxH, maskDestX, maskDestY, maskDestW, maskDestH, dpr = 1) {
        // 1. Placed piece canvas: stamped directly via globalCompositeOperation = 'source-in' (ZERO scratch CoW flushes!)
        const placedCanvas = piece.placedCanvas || document.createElement('canvas');
        if (placedCanvas.width !== stampPxW || placedCanvas.height !== stampPxH) {
            placedCanvas.width = stampPxW;
            placedCanvas.height = stampPxH;
        } else {
            placedCanvas.getContext('2d').clearRect(0, 0, stampPxW, stampPxH);
        }
        const pctx = placedCanvas.getContext('2d');
        pctx.globalCompositeOperation = 'source-over';

        // Draw scanned Alpha Mask (plus sub-pixel seam guard so adjacent masks sum to 100% opacity)
        pctx.drawImage(piece.maskCanvas, maskDestX, maskDestY, maskDestW, maskDestH);
        pctx.drawImage(piece.maskCanvas, maskDestX - 0.45, maskDestY, maskDestW, maskDestH);
        pctx.drawImage(piece.maskCanvas, maskDestX + 0.45, maskDestY, maskDestW, maskDestH);
        pctx.drawImage(piece.maskCanvas, maskDestX, maskDestY - 0.45, maskDestW, maskDestH);
        pctx.drawImage(piece.maskCanvas, maskDestX, maskDestY + 0.45, maskDestW, maskDestH);

        // Punch out puzzle motif sub-rectangle using globalCompositeOperation = 'source-in'
        pctx.globalCompositeOperation = 'source-in';
        pctx.drawImage(boardMotifCanvas, px0, py0, stampPxW, stampPxH, 0, 0, stampPxW, stampPxH);
        pctx.globalCompositeOperation = 'source-over';

        // 2. Loose / tray piece canvas: pre-baked multi-tap feathered drop shadow + top-left cardboard bevel
        // directly on looseCanvas with ZERO scratch canvases and ZERO runtime shadowBlur!
        const padPx = Math.max(5, Math.ceil(7 * dpr));
        const looseW = stampPxW + padPx * 2;
        const looseH = stampPxH + padPx * 2;

        const looseCanvas = piece.looseCanvas || document.createElement('canvas');
        if (looseCanvas.width !== looseW || looseCanvas.height !== looseH) {
            looseCanvas.width = looseW;
            looseCanvas.height = looseH;
        } else {
            looseCanvas.getContext('2d').clearRect(0, 0, looseW, looseH);
        }
        const lctx = looseCanvas.getContext('2d');
        lctx.globalCompositeOperation = 'source-over';

        const mx = padPx + maskDestX;
        const my = padPx + maskDestY;

        // Multi-tap feathered silhouette shadow (tinted dark in a single source-in pass!)
        lctx.globalAlpha = 0.14;
        lctx.drawImage(piece.maskCanvas, mx + 3.4 * dpr, my + 5.6 * dpr, maskDestW, maskDestH);
        lctx.globalAlpha = 0.20;
        lctx.drawImage(piece.maskCanvas, mx + 2.0 * dpr, my + 3.5 * dpr, maskDestW, maskDestH);
        lctx.globalAlpha = 0.30;
        lctx.drawImage(piece.maskCanvas, mx + 0.9 * dpr, my + 1.5 * dpr, maskDestW, maskDestH);
        lctx.globalAlpha = 1.0;

        lctx.globalCompositeOperation = 'source-in';
        lctx.fillStyle = '#060200';
        lctx.fillRect(0, 0, looseW, looseH);

        // Tactile white cardboard highlight along top-left rim (piece.maskCanvas is already pure #ffffff!)
        lctx.globalCompositeOperation = 'source-over';
        lctx.globalAlpha = 0.48;
        lctx.drawImage(piece.maskCanvas, mx - 0.85 * dpr, my - 0.85 * dpr, maskDestW, maskDestH);
        lctx.globalAlpha = 1.0;

        // Blit the source-in stamped motif piece cleanly on top
        lctx.drawImage(placedCanvas, padPx, padPx);

        piece.loosePadCss = padPx / dpr;
        piece.placedCanvas = placedCanvas;
        piece.looseCanvas = looseCanvas;
    }
}

window.SilhouetteScanner = SilhouetteScanner;
window.PuzzleGenerator = SilhouetteScanner;
