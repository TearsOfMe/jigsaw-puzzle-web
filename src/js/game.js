function drawRoundedRect(ctx, x, y, w, h, r) {
    r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

/**
 * Jigsaw Puzzle Engine — Flood-Fill Alpha-Mask & 'source-in' Edition
 *
 * - Scans silhouette templates via SilhouetteScanner (pixel-level BFS Flood Fill)
 * - Zero mathematical Bézier curves for puzzle contours
 * - Exact motif stamping via globalCompositeOperation = 'source-in'
 * - Pixel-accurate hit / click detection via scanned mask alpha values
 */
class JigsawGame {
    constructor(canvas, options = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d', { alpha: false });
        this.dpr = Math.min(window.devicePixelRatio || 1, 2);

        this.image = null;
        this.imgUrl = null;
        this.customSilhouetteUrl = null;
        this.scanResult = null;
        this._loadToken = 0;

        this.rows = options.rows || 9;
        this.cols = options.cols || 10;
        this.allowRotation = options.rotation || false;

        this.pieces = [];
        this.pieceById = new Map();
        this.groups = {}; // Map of groupId -> Array of piece IDs
        this.trayPieces = []; // Pieces currently sitting in the tray

        // Offscreen static layer caches for 60 FPS iPad Retina rendering
        this.staticBoardCanvas = null;
        this._staticBoardDirty = true;
        this.trayBgCanvas = null;
        this.trayOverlayCanvas = null;
        this._trayCacheKey = '';
        this._rafRenderId = 0;
        this._saveTimerId = 0;
        this._savePending = false;
        this._canvasRect = null;

        // Board layout geometry
        this.boardWidth = 800;
        this.boardHeight = 600;
        this.boardX = 50;
        this.boardY = 50;
        this.pieceWidth = 100;
        this.pieceHeight = 100;
        this._lastBoardRect = null;
        this._pendingRestoreBoard = null;

        // Tray geometry (calibrated to iPad 8 1080x810 display proportions)
        this.trayHeight = 114;
        this.trayY = 696;
        this.trayScrollX = 0;
        this.maxTrayScrollX = 0;

        // Interaction state
        this.selectedGroupId = null;
        this.dragOffset = { x: 0, y: 0 };
        this.isDragging = false;
        this.isPanningTray = false;
        this.touchTrayCandidate = null;
        this.startTrayX = 0;
        this.startScrollX = 0;
        this.filterEdgesOnly = false;
        this.showGhost = false;

        this.isCompleted = false;
        this.onCompleteCallback = null;
        this.onProgressCallback = null;
        this.onScanCompleteCallback = null;

        this.initEvents();
        this.resize();
        window.addEventListener('resize', () => this.resize());
        window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 80));
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', () => this.resize());
        }
        const flushPendingSave = () => {
            if (this._savePending) {
                this._flushSaveState();
            }
        };
        window.addEventListener('pagehide', flushPendingSave);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') flushPendingSave();
        });
    }

    scheduleRender() {
        if (this._rafRenderId) return;
        this._rafRenderId = requestAnimationFrame(() => {
            this._rafRenderId = 0;
            this.render();
        });
    }

    returnAllLoosePiecesToTray() {
        let changed = false;
        for (const p of this.pieces) {
            if (!p.isPlaced && !p.inTray) {
                const grp = this.groups[p.groupId];
                if (grp && grp.length === 1) {
                    p.inTray = true;
                    if (!this.trayPieces.includes(p)) {
                        this.trayPieces.push(p);
                    }
                    changed = true;
                }
            }
        }
        if (changed) {
            this.layoutTray();
            this.saveState();
            this.render();
            if (window.soundManager) window.soundManager.playRotate();
        }
    }

    saveState(immediate = false) {
        if (!this.image || !this.imgUrl || this.pieces.length === 0) return;
        if (this.customSilhouetteUrl && this.customSilhouetteUrl.startsWith('data:')) return;
        if (this.imgUrl && this.imgUrl.startsWith('data:')) return;

        if (immediate) {
            this._flushSaveState();
            return;
        }
        this._savePending = true;
        if (this._saveTimerId) clearTimeout(this._saveTimerId);
        this._saveTimerId = setTimeout(() => this._flushSaveState(), 180);
    }

    _flushSaveState() {
        this._savePending = false;
        if (this._saveTimerId) {
            clearTimeout(this._saveTimerId);
            this._saveTimerId = 0;
        }
        if (!this.image || !this.imgUrl || this.pieces.length === 0) return;
        if (this.customSilhouetteUrl && this.customSilhouetteUrl.startsWith('data:')) return;
        if (this.imgUrl && this.imgUrl.startsWith('data:')) return;
        try {
            const state = {
                version: 'floodfill_mask_v2',
                imgUrl: this.imgUrl,
                customSilhouetteUrl: this.customSilhouetteUrl || null,
                rows: this.rows,
                cols: this.cols,
                allowRotation: this.allowRotation,
                isCompleted: this.isCompleted,
                boardX: this.boardX,
                boardY: this.boardY,
                boardWidth: this.boardWidth,
                boardHeight: this.boardHeight,
                groups: this.groups,
                trayPieceIds: this.trayPieces.map(p => p.id),
                pieces: this.pieces.map(p => ({
                    id: p.id,
                    currentX: p.currentX,
                    currentY: p.currentY,
                    rotation: p.rotation,
                    isPlaced: p.isPlaced,
                    inTray: p.inTray,
                    groupId: p.groupId
                }))
            };
            localStorage.setItem('vortex_jigsaw_savegame', JSON.stringify(state));
        } catch (e) {
            console.warn('LocalStorage save failed:', e);
        }
    }

    hasSavedState() {
        return !!localStorage.getItem('vortex_jigsaw_savegame');
    }

    clearSavedState() {
        this._savePending = false;
        if (this._saveTimerId) {
            clearTimeout(this._saveTimerId);
            this._saveTimerId = 0;
        }
        localStorage.removeItem('vortex_jigsaw_savegame');
    }

    getPieceById(id) {
        return this.pieceById.get(id);
    }

    /**
     * Pixel-accurate hit detection via the Flood-Fill scanned Alpha Mask (alpha >= alphaThreshold).
     * Accounts for piece position, custom thumbnail scale (tray), and piece rotation (0/90/180/270°).
     */
    isPointInPieceMask(piece, worldX, worldY, customX = null, customY = null, customScale = 1.0, alphaThreshold = 20) {
        if (!piece || !piece.maskAlpha || piece.width <= 0 || piece.height <= 0) {
            return false;
        }

        const posX = customX !== null ? customX : piece.currentX;
        const posY = customY !== null ? customY : piece.currentY;

        const scaledW = piece.width * customScale;
        const scaledH = piece.height * customScale;
        const centerX = posX + scaledW / 2;
        const centerY = posY + scaledH / 2;

        // Fast bounding circle / rotated AABB pre-reject before array lookup
        const dx = worldX - centerX;
        const dy = worldY - centerY;
        const maxHalf = Math.max(scaledW, scaledH) * 0.72;
        if (Math.abs(dx) > maxHalf || Math.abs(dy) > maxHalf) {
            return false;
        }

        // Inverse rotation around piece center
        let rotX = dx;
        let rotY = dy;
        if (piece.rotation !== 0) {
            const rad = (-piece.rotation * Math.PI) / 180;
            const cosR = Math.cos(rad);
            const sinR = Math.sin(rad);
            rotX = dx * cosR - dy * sinR;
            rotY = dx * sinR + dy * cosR;
        }

        // Inverse scale into unscaled piece CSS space [0 .. piece.width] x [0 .. piece.height]
        const localX = (rotX / customScale) + piece.width / 2;
        const localY = (rotY / customScale) + piece.height / 2;

        const maskOffsetCssX = piece.maskOffsetCssX || 0;
        const maskOffsetCssY = piece.maskOffsetCssY || 0;
        const maskCssW = piece.maskCssW || piece.width;
        const maskCssH = piece.maskCssH || piece.height;

        const mx = Math.floor(((localX - maskOffsetCssX) / maskCssW) * piece.maskW);
        const my = Math.floor(((localY - maskOffsetCssY) / maskCssH) * piece.maskH);

        if (mx < 0 || mx >= piece.maskW || my < 0 || my >= piece.maskH) {
            return false;
        }

        return piece.maskAlpha[my * piece.maskW + mx] >= alphaThreshold;
    }

    /**
     * Single source of truth for bottom tray bolster, compact square button, and scrollable channel metrics.
     * Calibrated 1:1 to iPad 8 (1080x810 CSS px): trayHeight=114, bolsterW=93, btnSize=66, channel=894px.
     */
    getTrayMetrics() {
        const th = this.trayHeight || 114;
        const bolsterW = Math.round(th * 0.82);
        const arcSagitta = Math.max(4, Math.round(th * 0.065));
        const btnSize = Math.round(th * 0.58);
        const btnY = Math.round(this.trayY + (th - btnSize) / 2);
        const leftBtnX = Math.round((bolsterW - btnSize) / 2);
        const rightBtnX = Math.round(this.width - bolsterW + (bolsterW - btnSize) / 2);

        const piecesAreaX = bolsterW;
        const piecesAreaRight = Math.max(piecesAreaX + 80, this.width - bolsterW);
        const piecesAreaW = piecesAreaRight - piecesAreaX;

        return {
            bolsterW,
            arcSagitta,
            btnSize,
            leftBtn: { x: leftBtnX, y: btnY, w: btnSize, h: btnSize },
            rightBtn: { x: rightBtnX, y: btnY, w: btnSize, h: btnSize },
            piecesAreaX,
            piecesAreaRight,
            piecesAreaW
        };
    }

    resize() {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        this.dpr = dpr;
        const rect = this.canvas.parentElement.getBoundingClientRect();
        this.width = rect.width;
        this.height = rect.height;

        this.canvas.width = Math.floor(this.width * dpr);
        this.canvas.height = Math.floor(this.height * dpr);
        this._canvasRect = this.canvas.getBoundingClientRect();
        this.ctx.resetTransform();
        this.ctx.scale(dpr, dpr);

        this._staticBoardDirty = true;
        this._trayCacheKey = '';
        this.updateLayout();
        this.render();
    }

    updateLayout() {
        const isPortrait = this.height > this.width;
        this.trayHeight = isPortrait
            ? Math.max(106, Math.min(138, Math.round(this.height * 0.122)))
            : Math.max(96, Math.min(126, Math.round(this.height * 0.141)));
        this.trayY = Math.max(0, this.height - this.trayHeight);
        this._staticBoardDirty = true;

        if (!this.image || !this.scanResult || this.pieces.length === 0) return;

        const dpr = this.dpr || Math.min(window.devicePixelRatio || 1, 2);
        const prevBoard = this._pendingRestoreBoard || this._lastBoardRect;
        this._pendingRestoreBoard = null;

        // Preserve relative centers of loose pieces on the board before dimensions change
        const looseRelCenters = new Map();
        if (prevBoard && prevBoard.w > 0 && prevBoard.h > 0) {
            for (const p of this.pieces) {
                if (!p.isPlaced && !p.inTray) {
                    const oldW = p.width || (prevBoard.w / Math.max(1, this.cols));
                    const oldH = p.height || (prevBoard.h / Math.max(1, this.rows));
                    looseRelCenters.set(p.id, {
                        rx: ((p.currentX + oldW / 2) - prevBoard.x) / prevBoard.w,
                        ry: ((p.currentY + oldH / 2) - prevBoard.y) / prevBoard.h
                    });
                }
            }
        }

        // Tabletop framing calibrated to iPad 8 (1080x810): ~26px top/bottom, ~73px left/right parking margins
        const marginTop = Math.max(14, Math.round(this.trayY * 0.038));
        const marginBottom = marginTop;
        const marginX = isPortrait
            ? Math.max(14, Math.round(this.width * 0.035))
            : Math.max(24, Math.round(this.width * 0.068));

        const availW = Math.max(100, this.width - marginX * 2);
        const availH = Math.max(100, this.trayY - marginTop - marginBottom);
        const imgAspect = this.image.width / this.image.height;

        let rawBoardW, rawBoardH;
        if (availW / availH > imgAspect) {
            rawBoardH = availH;
            rawBoardW = rawBoardH * imgAspect;
        } else {
            rawBoardW = availW;
            rawBoardH = rawBoardW / imgAspect;
        }

        // Align board origin & dimensions to exact device pixels so stamped masks blit 1:1 without blur
        const boardPxW = Math.max(1, Math.round(rawBoardW * dpr));
        const boardPxH = Math.max(1, Math.round(rawBoardH * dpr));
        this.boardWidth = boardPxW / dpr;
        this.boardHeight = boardPxH / dpr;
        this.boardX = Math.round((marginX + (availW - this.boardWidth) / 2) * dpr) / dpr;
        this.boardY = Math.round((marginTop + (availH - this.boardHeight) / 2) * dpr) / dpr;

        this.pieceWidth = this.boardWidth / Math.max(1, this.cols);
        this.pieceHeight = this.boardHeight / Math.max(1, this.rows);

        // Stamp every piece from the motif using its Flood-Fill Alpha Mask & source-in
        this.stampAllPieces(boardPxW, boardPxH, dpr);

        // Update piece positions on board
        for (const p of this.pieces) {
            if (p.isPlaced) {
                p.currentX = p.targetX;
                p.currentY = p.targetY;
            } else if (!p.inTray && looseRelCenters.has(p.id)) {
                const rel = looseRelCenters.get(p.id);
                p.currentX = this.boardX + rel.rx * this.boardWidth - p.width / 2;
                p.currentY = this.boardY + rel.ry * this.boardHeight - p.height / 2;
            }
        }

        this._lastBoardRect = {
            x: this.boardX,
            y: this.boardY,
            w: this.boardWidth,
            h: this.boardHeight
        };

        this.layoutTray();
    }

    /**
     * Renders the full motif image once at exact board device-pixel resolution and punches out
     * every piece individually via SilhouetteScanner.stampPieceWithMask (globalCompositeOperation = 'source-in').
     */
    stampAllPieces(boardPxW, boardPxH, dpr) {
        const boardMotifCanvas = document.createElement('canvas');
        boardMotifCanvas.width = boardPxW;
        boardMotifCanvas.height = boardPxH;
        const mctx = boardMotifCanvas.getContext('2d');
        mctx.imageSmoothingEnabled = true;
        mctx.imageSmoothingQuality = 'high';
        mctx.drawImage(this.image, 0, 0, boardPxW, boardPxH);

        const pxScaleX = boardPxW / this.scanResult.assembledWidth;
        const pxScaleY = boardPxH / this.scanResult.assembledHeight;

        for (const p of this.pieces) {
            const exactX0 = p.assembledX * pxScaleX;
            const exactY0 = p.assembledY * pxScaleY;
            const exactW = p.maskW * pxScaleX;
            const exactH = p.maskH * pxScaleY;

            // 1px interior safety margin prevents bevel/seam guard clipping on inner edges,
            // while clamping to [0..boardPxW] x [0..boardPxH] keeps outer puzzle borders razor-straight
            const px0 = Math.max(0, Math.floor(exactX0) - 1);
            const py0 = Math.max(0, Math.floor(exactY0) - 1);
            const px1 = Math.min(boardPxW, Math.ceil(exactX0 + exactW) + 1);
            const py1 = Math.min(boardPxH, Math.ceil(exactY0 + exactH) + 1);

            const stampPxW = Math.max(1, px1 - px0);
            const stampPxH = Math.max(1, py1 - py0);

            const maskDestX = exactX0 - px0;
            const maskDestY = exactY0 - py0;

            p.targetX = this.boardX + px0 / dpr;
            p.targetY = this.boardY + py0 / dpr;
            p.width = stampPxW / dpr;
            p.height = stampPxH / dpr;

            p.maskOffsetCssX = maskDestX / dpr;
            p.maskOffsetCssY = maskDestY / dpr;
            p.maskCssW = exactW / dpr;
            p.maskCssH = exactH / dpr;

            SilhouetteScanner.stampPieceWithMask(
                p,
                boardMotifCanvas,
                px0,
                py0,
                stampPxW,
                stampPxH,
                maskDestX,
                maskDestY,
                exactW,
                exactH,
                dpr
            );
        }
    }

    layoutTray() {
        const { piecesAreaW, arcSagitta } = this.getTrayMetrics();
        const frameCenterY = this.trayY + this.trayHeight * 0.50;

        // One single uniform scale shared across ALL pieces in the puzzle so tab-to-socket
        // proportions stay 100% true and ~10-11 selection pieces fit side-by-side on iPad 8
        let maxPieceH = 1;
        let sumPieceW = 0;
        for (let i = 0; i < this.pieces.length; i++) {
            const p = this.pieces[i];
            if (p.height > maxPieceH) maxPieceH = p.height;
            sumPieceW += p.width;
        }
        const avgPieceW = this.pieces.length > 0 ? (sumPieceW / this.pieces.length) : 80;

        const maxTrayPieceH = this.trayHeight * 0.83;
        const targetAvgTrayW = this.trayHeight * 0.70;
        const uniformTrayScale = Math.min(
            maxTrayPieceH / Math.max(1, maxPieceH),
            targetAvgTrayW / Math.max(1, avgPieceW),
            1.40
        );

        const padding = Math.max(6, Math.round(this.trayHeight * 0.062));
        let curX = arcSagitta + padding;

        for (let i = 0; i < this.trayPieces.length; i++) {
            const p = this.trayPieces[i];
            const pw = p.width * uniformTrayScale;
            const ph = p.height * uniformTrayScale;
            p.thumbScale = uniformTrayScale;
            p.trayX = curX;
            p.trayY = frameCenterY - ph / 2;
            p.inTray = true;
            curX += pw + padding;
        }

        this.maxTrayScrollX = Math.max(0, curX - piecesAreaW + arcSagitta);
        this.trayScrollX = Math.min(0, Math.max(-this.maxTrayScrollX, this.trayScrollX));
    }

    async loadPuzzle(imgUrl, rows = 9, cols = 10, allowRotation = false, savedState = null, customSilhouetteUrl = null) {
        const token = ++this._loadToken;
        this.imgUrl = imgUrl;
        this.rows = rows;
        this.cols = cols;
        this.allowRotation = allowRotation;
        this.customSilhouetteUrl = customSilhouetteUrl || (savedState && savedState.customSilhouetteUrl) || null;
        this.isCompleted = false;
        this._lastBoardRect = null;

        const silhouetteUrl = this.customSilhouetteUrl || SilhouetteScanner.getTemplateUrl(rows, cols);

        const loadMotifPromise = new Promise((resolve, reject) => {
            const img = new Image();
            if (!imgUrl.startsWith('data:')) {
                img.crossOrigin = 'anonymous';
            }
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error(`Konnte Puzzle-Motiv nicht laden: ${imgUrl}`));
            img.src = imgUrl;
        });

        try {
            const [img, scanResult] = await Promise.all([
                loadMotifPromise,
                SilhouetteScanner.loadAndScan(silhouetteUrl)
            ]);

            if (token !== this._loadToken) return;

            this.image = img;
            this.scanResult = scanResult;
            this.rows = scanResult.rows;
            this.cols = scanResult.cols;

            if (this.onScanCompleteCallback) {
                this.onScanCompleteCallback(scanResult, silhouetteUrl);
            }

            if (
                savedState &&
                savedState.version === 'floodfill_mask_v2' &&
                Array.isArray(savedState.pieces) &&
                savedState.pieces.length === scanResult.pieces.length
            ) {
                this.restoreFromState(savedState);
            } else {
                this.buildPieces();
            }

            this.updateLayout();
            this.render();
            this.checkCompletion();
            this.saveState();
        } catch (err) {
            console.error('Fehler beim Laden/Scannen des Puzzles:', err);
        }
    }

    restoreFromState(state) {
        this.groups = state.groups || {};
        this.pieces = [];
        this.pieceById.clear();
        this.trayPieces = [];

        if (state.boardWidth > 0 && state.boardHeight > 0) {
            this._pendingRestoreBoard = {
                x: state.boardX || 0,
                y: state.boardY || 0,
                w: state.boardWidth,
                h: state.boardHeight
            };
        }

        const savedById = new Map();
        for (const sp of state.pieces) {
            savedById.set(sp.id, sp);
        }

        for (const scanned of this.scanResult.pieces) {
            const sp = savedById.get(scanned.id) || {};
            const piece = {
                id: scanned.id,
                row: scanned.row,
                col: scanned.col,
                isBorder: scanned.isBorder,
                assembledX: scanned.assembledX,
                assembledY: scanned.assembledY,
                maskW: scanned.maskW,
                maskH: scanned.maskH,
                maskAlpha: scanned.maskAlpha,
                maskCanvas: scanned.maskCanvas,
                neighbors: scanned.neighbors ? scanned.neighbors.slice() : [],
                rotation: sp.rotation !== undefined ? sp.rotation : 0,
                currentX: sp.currentX || 0,
                currentY: sp.currentY || 0,
                targetX: 0,
                targetY: 0,
                width: 0,
                height: 0,
                isPlaced: !!sp.isPlaced,
                inTray: sp.inTray !== undefined ? sp.inTray : true,
                groupId: sp.groupId !== undefined ? sp.groupId : scanned.id,
                loosePadCss: 0,
                placedCanvas: null,
                looseCanvas: null
            };
            this.pieces.push(piece);
            this.pieceById.set(piece.id, piece);
        }

        if (Array.isArray(state.trayPieceIds) && state.trayPieceIds.length > 0) {
            for (const pid of state.trayPieceIds) {
                const p = this.getPieceById(pid);
                if (p && p.inTray) {
                    this.trayPieces.push(p);
                }
            }
        } else {
            this.trayPieces = this.pieces.filter(p => p.inTray);
        }
    }

    buildPieces() {
        this.pieces = [];
        this.pieceById.clear();
        this.groups = {};
        this.trayPieces = [];

        for (const scanned of this.scanResult.pieces) {
            const piece = {
                id: scanned.id,
                row: scanned.row,
                col: scanned.col,
                isBorder: scanned.isBorder,
                assembledX: scanned.assembledX,
                assembledY: scanned.assembledY,
                maskW: scanned.maskW,
                maskH: scanned.maskH,
                maskAlpha: scanned.maskAlpha,
                maskCanvas: scanned.maskCanvas,
                neighbors: scanned.neighbors ? scanned.neighbors.slice() : [],
                rotation: this.allowRotation ? Math.floor(Math.random() * 4) * 90 : 0,
                currentX: 0,
                currentY: 0,
                targetX: 0,
                targetY: 0,
                width: 0,
                height: 0,
                isPlaced: false,
                inTray: true,
                groupId: scanned.id,
                loosePadCss: 0,
                placedCanvas: null,
                looseCanvas: null
            };

            this.pieces.push(piece);
            this.pieceById.set(piece.id, piece);
            this.groups[piece.id] = [piece.id];
            this.trayPieces.push(piece);
        }

        // Fisher-Yates shuffle
        for (let i = this.trayPieces.length - 1; i > 0; i--) {
            const j = (Math.random() * (i + 1)) | 0;
            const tmp = this.trayPieces[i];
            this.trayPieces[i] = this.trayPieces[j];
            this.trayPieces[j] = tmp;
        }
    }

    initEvents() {
        this.trayVelocityX = 0;
        this.lastMoveTime = 0;
        this.lastMoveX = 0;
        this.animFrameId = null;

        const applyTrayInertia = () => {
            if (Math.abs(this.trayVelocityX) > 0.4) {
                this.trayScrollX += this.trayVelocityX;
                this.trayVelocityX *= 0.92;
                if (this.trayScrollX > 0) {
                    this.trayScrollX *= 0.7;
                    if (this.trayScrollX < 1) this.trayScrollX = 0;
                } else if (this.trayScrollX < -this.maxTrayScrollX) {
                    const over = -this.maxTrayScrollX - this.trayScrollX;
                    this.trayScrollX += over * 0.3;
                }
                this.render();
                this.animFrameId = requestAnimationFrame(applyTrayInertia);
            } else {
                this.trayVelocityX = 0;
                this.trayScrollX = Math.min(0, Math.max(-this.maxTrayScrollX, this.trayScrollX));
                this.render();
            }
        };

        let lastTapTime = 0;
        let lastTapPieceId = null;

        const handleTapRotate = (pos) => {
            if (!this.allowRotation) return false;
            const now = Date.now();
            for (let i = this.pieces.length - 1; i >= 0; i--) {
                const p = this.pieces[i];
                if (p.isPlaced || p.inTray) continue;
                // Pixel-accurate alpha hit check on the piece mask
                if (this.isPointInPieceMask(p, pos.x, pos.y)) {
                    if (now - lastTapTime < 320 && lastTapPieceId === p.id) {
                        this.rotateGroup(p.groupId);
                        this.saveState();
                        lastTapTime = 0;
                        lastTapPieceId = null;
                        return true;
                    } else {
                        lastTapTime = now;
                        lastTapPieceId = p.id;
                    }
                    break;
                }
            }
            return false;
        };

        const getPos = (e) => {
            const rect = this._canvasRect || (this._canvasRect = this.canvas.getBoundingClientRect());
            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            return {
                x: clientX - rect.left,
                y: clientY - rect.top
            };
        };

        let lastTouchTimestamp = 0;

        const onDown = (e) => {
            if (e.touches) {
                lastTouchTimestamp = Date.now();
                if (e.touches.length > 1) return;
                if (e.cancelable) e.preventDefault();
            } else if (Date.now() - lastTouchTimestamp < 450) {
                // Ignore synthetic mousedown emitted by iPadOS Safari after touchstart
                return;
            }
            const pos = getPos(e);
            if (handleTapRotate(pos)) return;

            // Auto-close header if open and user clicked elsewhere on the board
            const header = document.getElementById('mainHeader');
            const isClickingMenuBtn = !!(this.trayRightBtn &&
                pos.x >= this.trayRightBtn.x && pos.x <= this.trayRightBtn.x + this.trayRightBtn.w &&
                pos.y >= this.trayRightBtn.y && pos.y <= this.trayRightBtn.y + this.trayRightBtn.h);

            if (header && header.classList.contains('visible') && !isClickingMenuBtn) {
                header.classList.remove('visible');
            }

            // 1. Check if clicking inside tray dock
            if (pos.y >= this.trayY) {
                // Left Button (Hint)
                if (this.trayLeftBtn &&
                    pos.x >= this.trayLeftBtn.x && pos.x <= this.trayLeftBtn.x + this.trayLeftBtn.w &&
                    pos.y >= this.trayLeftBtn.y && pos.y <= this.trayLeftBtn.y + this.trayLeftBtn.h) {
                    this.hintNextPiece();
                    return;
                }

                // Right Button (Menu)
                if (isClickingMenuBtn) {
                    if (header) {
                        header.classList.toggle('visible');
                    }
                    if (window.soundManager && window.soundManager.playClick) {
                        window.soundManager.playClick();
                    }
                    return;
                }

                const { piecesAreaX, piecesAreaRight } = this.getTrayMetrics();

                if (pos.x >= piecesAreaX && pos.x <= piecesAreaRight) {
                    for (let i = this.trayPieces.length - 1; i >= 0; i--) {
                        const p = this.trayPieces[i];
                        if (this.filterEdgesOnly && !p.isBorder) continue;

                        const thumbScale = p.thumbScale || 0.75;
                        const drawX = piecesAreaX + p.trayX + this.trayScrollX;

                        // Pixel-accurate click detection via scanned alpha mask
                        if (this.isPointInPieceMask(p, pos.x, pos.y, drawX, p.trayY, thumbScale)) {
                            this.touchTrayCandidate = {
                                piece: p,
                                index: i,
                                startX: pos.x,
                                startY: pos.y
                            };
                            this.isPanningTray = true;
                            this.startTrayX = pos.x;
                            this.startScrollX = this.trayScrollX;
                            this.lastMoveX = pos.x;
                            this.lastMoveTime = Date.now();
                            this.trayVelocityX = 0;
                            if (this.animFrameId) cancelAnimationFrame(this.animFrameId);
                            return;
                        }
                    }
                }

                // Drag/scroll the tray horizontally
                this.isPanningTray = true;
                this.startTrayX = pos.x;
                this.startScrollX = this.trayScrollX;
                this.lastMoveX = pos.x;
                this.lastMoveTime = Date.now();
                this.trayVelocityX = 0;
                if (this.animFrameId) cancelAnimationFrame(this.animFrameId);
                return;
            }

            // 2. Check loose pieces on board (from top z-order down) via pixel-exact mask alpha
            for (let i = this.pieces.length - 1; i >= 0; i--) {
                const p = this.pieces[i];
                if (p.inTray || p.isPlaced) continue;

                if (this.isPointInPieceMask(p, pos.x, pos.y)) {
                    this.selectedGroupId = p.groupId;
                    this.bringGroupToTop(p.groupId);
                    this.isDragging = true;
                    this.dragOffset = {
                        x: pos.x - p.currentX,
                        y: pos.y - p.currentY
                    };
                    this.canvas.style.cursor = 'grabbing';
                    this.render();
                    return;
                }
            }
        };

        const onMove = (e) => {
            const pos = getPos(e);

            if (this.touchTrayCandidate) {
                const cand = this.touchTrayCandidate;
                const distY = cand.startY - pos.y;
                const distX = Math.abs(pos.x - cand.startX);

                if (distY > 16 || (pos.y < this.trayY - 8)) {
                    const p = cand.piece;
                    p.originalTrayIndex = cand.index;
                    const idx = this.trayPieces.indexOf(p);
                    if (idx !== -1) this.trayPieces.splice(idx, 1);
                    p.inTray = false;

                    const isTouch = !!e.touches;
                    const liftY = isTouch ? Math.min(42, p.height * 0.34) : 0;
                    p.currentX = pos.x - p.width / 2;
                    p.currentY = pos.y - p.height / 2 - liftY;

                    this.selectedGroupId = p.groupId;
                    this.bringGroupToTop(p.groupId);
                    this.isDragging = true;
                    this.dragOffset = {
                        x: pos.x - p.currentX,
                        y: pos.y - p.currentY
                    };
                    this.isPanningTray = false;
                    this.touchTrayCandidate = null;
                    this.canvas.style.cursor = 'grabbing';

                    this.layoutTray();
                    this.render();
                    return;
                } else if (distX > 14) {
                    this.touchTrayCandidate = null;
                }
            }

            if (this.isPanningTray) {
                const now = Date.now();
                const dt = Math.max(1, now - this.lastMoveTime);
                const dx = pos.x - this.lastMoveX;
                this.trayVelocityX = (dx / dt) * 16;
                this.lastMoveX = pos.x;
                this.lastMoveTime = now;

                const deltaX = pos.x - this.startTrayX;
                let targetScroll = this.startScrollX + deltaX;
                if (targetScroll > 0) targetScroll *= 0.35;
                if (targetScroll < -this.maxTrayScrollX) {
                    const over = targetScroll - (-this.maxTrayScrollX);
                    targetScroll = -this.maxTrayScrollX + over * 0.35;
                }
                this.trayScrollX = targetScroll;
                this.scheduleRender();
                return;
            }

            if (this.isDragging && this.selectedGroupId !== null) {
                const group = this.groups[this.selectedGroupId];
                if (!group || group.length === 0) return;

                const primary = this.getPieceById(group[0]);
                const targetCurrentX = pos.x - this.dragOffset.x;
                const targetCurrentY = pos.y - this.dragOffset.y;
                const deltaX = targetCurrentX - primary.currentX;
                const deltaY = targetCurrentY - primary.currentY;

                for (const pid of group) {
                    const gp = this.getPieceById(pid);
                    gp.currentX += deltaX;
                    gp.currentY += deltaY;
                }

                this.scheduleRender();
                return;
            }

            // Update desktop hover cursor using pixel-exact alpha mask check
            if (!e.touches) {
                let hoverCursor = 'default';
                if (pos.y >= this.trayY) {
                    const hitLeft = this.trayLeftBtn &&
                        pos.x >= this.trayLeftBtn.x && pos.x <= this.trayLeftBtn.x + this.trayLeftBtn.w &&
                        pos.y >= this.trayLeftBtn.y && pos.y <= this.trayLeftBtn.y + this.trayLeftBtn.h;
                    const hitRight = this.trayRightBtn &&
                        pos.x >= this.trayRightBtn.x && pos.x <= this.trayRightBtn.x + this.trayRightBtn.w &&
                        pos.y >= this.trayRightBtn.y && pos.y <= this.trayRightBtn.y + this.trayRightBtn.h;
                    if (hitLeft || hitRight) {
                        hoverCursor = 'pointer';
                    } else {
                        const { piecesAreaX, piecesAreaRight } = this.getTrayMetrics();
                        if (pos.x >= piecesAreaX && pos.x <= piecesAreaRight) {
                            for (let i = this.trayPieces.length - 1; i >= 0; i--) {
                                const p = this.trayPieces[i];
                                if (this.filterEdgesOnly && !p.isBorder) continue;
                                const drawX = piecesAreaX + p.trayX + this.trayScrollX;
                                if (this.isPointInPieceMask(p, pos.x, pos.y, drawX, p.trayY, p.thumbScale || 0.75)) {
                                    hoverCursor = 'grab';
                                    break;
                                }
                            }
                        }
                    }
                } else {
                    for (let i = this.pieces.length - 1; i >= 0; i--) {
                        const p = this.pieces[i];
                        if (p.inTray || p.isPlaced) continue;
                        if (this.isPointInPieceMask(p, pos.x, pos.y)) {
                            hoverCursor = 'grab';
                            break;
                        }
                    }
                }
                if (this.canvas.style.cursor !== hoverCursor) {
                    this.canvas.style.cursor = hoverCursor;
                }
            }
        };

        const onUp = () => {
            if (this.isDragging && this.selectedGroupId !== null) {
                const groupId = this.selectedGroupId;
                this.isDragging = false;
                this.selectedGroupId = null;
                this.canvas.style.cursor = 'default';

                // Return single piece back to tray if dropped inside tray dock
                const group = this.groups[groupId];
                if (group && group.length === 1) {
                    const p = this.getPieceById(group[0]);
                    if (p.currentY + p.height / 2 >= this.trayY) {
                        p.inTray = true;
                        const targetIdx = (typeof p.originalTrayIndex === 'number' && p.originalTrayIndex >= 0)
                            ? Math.min(p.originalTrayIndex, this.trayPieces.length)
                            : this.trayPieces.length;
                        this.trayPieces.splice(targetIdx, 0, p);
                        this.layoutTray();
                        this.saveState();
                        this.render();
                        if (window.soundManager) window.soundManager.playSnap();
                        return;
                    }
                }

                this.checkSnapping(groupId);
                this.saveState();
                this.render();
            }
            if (this.isPanningTray) {
                this.isPanningTray = false;
                this.touchTrayCandidate = null;
                applyTrayInertia();
            }
        };

        // Right-click to rotate (pixel-accurate mask alpha check)
        const onContextMenu = (e) => {
            e.preventDefault();
            if (!this.allowRotation) return;

            const pos = getPos(e);
            for (let i = this.pieces.length - 1; i >= 0; i--) {
                const p = this.pieces[i];
                if (p.isPlaced || p.inTray) continue;

                if (this.isPointInPieceMask(p, pos.x, pos.y)) {
                    this.rotateGroup(p.groupId);
                    this.saveState();
                    return;
                }
            }
        };

        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            this.trayScrollX = Math.min(0, Math.max(-this.maxTrayScrollX, this.trayScrollX - e.deltaY));
            this.scheduleRender();
        }, { passive: false });

        this.canvas.addEventListener('mousedown', onDown);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);

        this.canvas.addEventListener('touchstart', onDown, { passive: false });
        window.addEventListener('touchmove', onMove, { passive: false });
        window.addEventListener('touchend', onUp);
        this.canvas.addEventListener('contextmenu', onContextMenu);
    }

    rotateGroup(groupId) {
        const group = this.groups[groupId];
        if (!group || group.length === 0) return;

        if (window.soundManager) window.soundManager.playRotate();

        let sumCx = 0;
        let sumCy = 0;
        for (const pid of group) {
            const p = this.getPieceById(pid);
            sumCx += p.currentX + p.width / 2;
            sumCy += p.currentY + p.height / 2;
        }
        const pivotX = sumCx / group.length;
        const pivotY = sumCy / group.length;

        for (const pid of group) {
            const p = this.getPieceById(pid);
            const cx = p.currentX + p.width / 2;
            const cy = p.currentY + p.height / 2;
            const dx = cx - pivotX;
            const dy = cy - pivotY;
            p.currentX = (pivotX - dy) - p.width / 2;
            p.currentY = (pivotY + dx) - p.height / 2;
            p.rotation = (p.rotation + 90) % 360;
        }
        this.render();
    }

    bringGroupToTop(groupId) {
        const group = this.groups[groupId];
        if (!group) return;

        const groupPieces = this.pieces.filter(p => group.includes(p.id));
        const otherPieces = this.pieces.filter(p => !group.includes(p.id));
        this.pieces = [...otherPieces, ...groupPieces];
    }

    checkSnapping(groupId) {
        const group = this.groups[groupId];
        if (!group || group.length === 0) return;

        const snapDistance = Math.max(22, Math.min(55, Math.min(this.pieceWidth, this.pieceHeight) * 0.45));
        let snappedToBoard = false;

        // 1. Snap directly onto exact board target coordinates
        for (const pid of group) {
            const p = this.getPieceById(pid);
            if (p.rotation !== 0) continue;

            const dist = Math.hypot(p.currentX - p.targetX, p.currentY - p.targetY);
            if (dist < snapDistance) {
                for (const gpid of group) {
                    const gp = this.getPieceById(gpid);
                    gp.currentX = gp.targetX;
                    gp.currentY = gp.targetY;
                    gp.isPlaced = true;
                    this.stampPlacedPieceToStaticBoard(gp);
                }

                snappedToBoard = true;
                if (window.soundManager) window.soundManager.playSnap();
                break;
            }
        }

        // 2. Snap to an adjacent loose piece (checking O(1) neighbor list first instead of all N pieces)
        if (!snappedToBoard) {
            let merged = false;
            const groupSet = new Set(group);
            for (const pid of group) {
                if (merged) break;
                const p = this.getPieceById(pid);
                const candidates = (p.neighbors && p.neighbors.length > 0)
                    ? p.neighbors.map(nid => this.getPieceById(nid))
                    : this.pieces;

                for (const other of candidates) {
                    if (!other || groupSet.has(other.id) || other.inTray || other.isPlaced) continue;
                    if (p.rotation !== other.rotation) continue;

                    const baseVecX = (p.targetX + p.width / 2) - (other.targetX + other.width / 2);
                    const baseVecY = (p.targetY + p.height / 2) - (other.targetY + other.height / 2);

                    const rad = (p.rotation * Math.PI) / 180;
                    const cosR = Math.cos(rad);
                    const sinR = Math.sin(rad);
                    const expVecX = baseVecX * cosR - baseVecY * sinR;
                    const expVecY = baseVecX * sinR + baseVecY * cosR;

                    const actVecX = (p.currentX + p.width / 2) - (other.currentX + other.width / 2);
                    const actVecY = (p.currentY + p.height / 2) - (other.currentY + other.height / 2);

                    const diffDist = Math.hypot(actVecX - expVecX, actVecY - expVecY);
                    if (diffDist < snapDistance) {
                        const alignDx = expVecX - actVecX;
                        const alignDy = expVecY - actVecY;

                        for (const gpid of group) {
                            const gp = this.getPieceById(gpid);
                            gp.currentX += alignDx;
                            gp.currentY += alignDy;
                        }

                        const targetGroupId = other.groupId;
                        this.groups[targetGroupId].push(...group);
                        for (const gpid of group) {
                            this.getPieceById(gpid).groupId = targetGroupId;
                        }
                        delete this.groups[groupId];

                        if (window.soundManager) window.soundManager.playSnap();
                        merged = true;
                        break;
                    }
                }
            }
        }

        this.checkCompletion();
    }

    checkCompletion() {
        const placedCount = this.pieces.filter(p => p.isPlaced).length;
        if (this.onProgressCallback) {
            this.onProgressCallback(placedCount, this.pieces.length);
        }

        if (placedCount === this.pieces.length && !this.isCompleted && this.pieces.length > 0) {
            this.isCompleted = true;
            if (window.soundManager) window.soundManager.playVictory();
            if (this.onCompleteCallback) {
                this.onCompleteCallback();
            }
        }
    }

    hintNextPiece() {
        const unplaced = this.pieces.filter(p => !p.isPlaced);
        if (unplaced.length === 0) return;

        const arenaLoose = unplaced.filter(p => !p.inTray);
        const pool = (arenaLoose.length > 0) ? arenaLoose : unplaced;

        let chosen = null;
        for (const cand of pool) {
            const hasPlacedNeighbor = this.pieces.some(other =>
                other.isPlaced && cand.neighbors && cand.neighbors.includes(other.id)
            );
            if (hasPlacedNeighbor) {
                chosen = cand;
                break;
            }
        }
        if (!chosen) chosen = pool[0];

        if (chosen.inTray) {
            const idx = this.trayPieces.indexOf(chosen);
            if (idx !== -1) this.trayPieces.splice(idx, 1);
            chosen.inTray = false;
            this.layoutTray();
        }

        if (this.groups[chosen.groupId]) {
            this.groups[chosen.groupId] = this.groups[chosen.groupId].filter(id => id !== chosen.id);
            if (this.groups[chosen.groupId].length === 0) {
                delete this.groups[chosen.groupId];
            }
        }

        chosen.rotation = 0;
        chosen.currentX = chosen.targetX;
        chosen.currentY = chosen.targetY;
        chosen.isPlaced = true;
        chosen.groupId = chosen.id;
        this.groups[chosen.id] = [chosen.id];
        this.stampPlacedPieceToStaticBoard(chosen);

        for (const other of this.pieces) {
            if (other.id === chosen.id || !other.isPlaced) continue;
            const isNeighbor = chosen.neighbors && chosen.neighbors.includes(other.id);
            if (isNeighbor && other.groupId !== chosen.groupId) {
                const targetGid = other.groupId;
                const srcGid = chosen.groupId;
                if (this.groups[srcGid]) {
                    this.groups[targetGid].push(...this.groups[srcGid]);
                    for (const pid of this.groups[srcGid]) {
                        this.getPieceById(pid).groupId = targetGid;
                    }
                    delete this.groups[srcGid];
                }
            }
        }

        for (const other of this.pieces) {
            if (other.isPlaced || other.inTray || other.rotation !== 0) continue;
            const dist = Math.hypot(other.currentX - other.targetX, other.currentY - other.targetY);
            if (dist < 45) {
                other.currentX = other.targetX;
                other.currentY = other.targetY;
                other.isPlaced = true;
                this.stampPlacedPieceToStaticBoard(other);
                if (this.groups[other.groupId]) {
                    this.groups[other.groupId] = this.groups[other.groupId].filter(id => id !== other.id);
                    if (this.groups[other.groupId].length === 0) {
                        delete this.groups[other.groupId];
                    }
                }
                this.groups[chosen.groupId].push(other.id);
                other.groupId = chosen.groupId;
            }
        }

        if (window.soundManager) window.soundManager.playSnap();
        this.checkCompletion();
        this.saveState();
        this.render();
    }

    toggleEdgesOnly() {
        this.filterEdgesOnly = !this.filterEdgesOnly;
        this.render();
        return this.filterEdgesOnly;
    }

    toggleGhost() {
        this.showGhost = !this.showGhost;
        this._staticBoardDirty = true;
        this.render();
        return this.showGhost;
    }

    /**
     * Incrementally blits a newly placed piece onto the cached staticBoardCanvas in O(1)
     * so we never redraw placed pieces on subsequent drag/scroll frames.
     */
    stampPlacedPieceToStaticBoard(piece) {
        if (this._staticBoardDirty || !this.staticBoardCanvas || !piece || !piece.placedCanvas) {
            this._staticBoardDirty = true;
            return;
        }
        const sctx = this.staticBoardCanvas.getContext('2d');
        sctx.drawImage(piece.placedCanvas, piece.targetX, piece.targetY, piece.width, piece.height);
        // Re-apply subtle tray top cast-shadow strip if piece touches bottom margin near tray
        if (piece.targetY + piece.height > this.trayY - 12) {
            const shGrad = sctx.createLinearGradient(0, this.trayY - 12, 0, this.trayY);
            shGrad.addColorStop(0, 'rgba(0, 0, 0, 0)');
            shGrad.addColorStop(1, 'rgba(0, 0, 0, 0.36)');
            sctx.fillStyle = shGrad;
            sctx.fillRect(0, this.trayY - 12, this.width, 12);
        }
    }

    ensureStaticBoard() {
        const dpr = this.dpr || 1;
        const boardAreaH = Math.max(1, Math.ceil(this.trayY));
        const pxW = Math.max(1, Math.floor(this.width * dpr));
        const pxH = Math.max(1, Math.floor(boardAreaH * dpr));

        if (!this.staticBoardCanvas) {
            this.staticBoardCanvas = document.createElement('canvas');
        }
        if (this.staticBoardCanvas.width !== pxW || this.staticBoardCanvas.height !== pxH) {
            this.staticBoardCanvas.width = pxW;
            this.staticBoardCanvas.height = pxH;
            this._staticBoardDirty = true;
        }
        if (!this._staticBoardDirty) return;

        const sctx = this.staticBoardCanvas.getContext('2d', { alpha: false });
        sctx.resetTransform();
        sctx.scale(dpr, dpr);

        if (!this.matPatternCanvas || this.matPatternCanvas.width !== this.width || this.matPatternCanvas.height !== this.height) {
            this.createMatTexture(this.width, this.height);
        }
        if (this.matPatternCanvas) {
            sctx.drawImage(this.matPatternCanvas, 0, 0);
        }

        if (this.image && this.scanResult) {
            this.drawBoard(sctx);
            for (let i = 0; i < this.pieces.length; i++) {
                const p = this.pieces[i];
                if (p.isPlaced && p.placedCanvas) {
                    sctx.drawImage(p.placedCanvas, p.targetX, p.targetY, p.width, p.height);
                }
            }
        }

        // Bake upward tray dock drop-shadow onto bottom of static board (eliminates runtime shadowBlur!)
        if (boardAreaH > 12) {
            const shGrad = sctx.createLinearGradient(0, boardAreaH - 12, 0, boardAreaH);
            shGrad.addColorStop(0, 'rgba(0, 0, 0, 0)');
            shGrad.addColorStop(1, 'rgba(0, 0, 0, 0.38)');
            sctx.fillStyle = shGrad;
            sctx.fillRect(0, boardAreaH - 12, this.width, 12);
        }

        this._staticBoardDirty = false;
    }

    render() {
        if (this._rafRenderId) {
            cancelAnimationFrame(this._rafRenderId);
            this._rafRenderId = 0;
        }
        if (!this.width || !this.height) return;

        // 1+2+3. Blit cached wooden tabletop + inlaid board + all locked placed pieces in ONE GPU call!
        this.ensureStaticBoard();
        const boardAreaH = Math.max(1, Math.ceil(this.trayY));
        this.ctx.drawImage(this.staticBoardCanvas, 0, 0, this.width, boardAreaH);

        if (!this.image || !this.scanResult) {
            this.drawTray();
            return;
        }

        // 4. Loose pieces on board (except currently dragged group)
        const draggedPieceIds = (this.isDragging && this.selectedGroupId !== null)
            ? (this.groups[this.selectedGroupId] || [])
            : [];
        const hasDragged = draggedPieceIds.length > 0;
        const draggedSet = hasDragged ? new Set(draggedPieceIds) : null;

        for (let i = 0; i < this.pieces.length; i++) {
            const p = this.pieces[i];
            if (!p.isPlaced && !p.inTray && (!hasDragged || !draggedSet.has(p.id))) {
                this.drawPiece(p);
            }
        }

        // 5. Piece tray dock at bottom (uses pre-rendered static mahogany & bolster layers)
        this.drawTray();

        // 6. Currently dragged pieces on top of everything
        if (hasDragged) {
            for (let i = 0; i < draggedPieceIds.length; i++) {
                this.drawPiece(this.getPieceById(draggedPieceIds[i]));
            }
        }
    }

    drawBackground() {
        if (!this.matPatternCanvas || this.matPatternCanvas.width !== this.width || this.matPatternCanvas.height !== this.height) {
            this.createMatTexture(this.width, this.height);
        }
        if (this.matPatternCanvas) {
            this.ctx.drawImage(this.matPatternCanvas, 0, 0);
        }
    }

    createMatTexture(w, h) {
        const offCanvas = document.createElement('canvas');
        offCanvas.width = w;
        offCanvas.height = h;
        const ctx = offCanvas.getContext('2d');

        // Realistic warm Walnut / Oak Wooden Tabletop (Holztisch-Optik)
        const plankH = Math.max(54, Math.round(h / 11));
        const plankPalettes = [
            ['#4a2c18', '#5c3820', '#432714'],
            ['#53321c', '#653e24', '#492b17'],
            ['#442815', '#55331d', '#3d2312'],
            ['#58361f', '#6b4327', '#4d2e19']
        ];

        let plankIdx = 0;
        for (let py = 0; py < h; py += plankH) {
            const curH = Math.min(plankH, h - py);
            const pal = plankPalettes[plankIdx % plankPalettes.length];

            // Base warm wood plank gradient
            const pGrad = ctx.createLinearGradient(0, py, 0, py + curH);
            pGrad.addColorStop(0, pal[0]);
            pGrad.addColorStop(0.45, pal[1]);
            pGrad.addColorStop(1, pal[2]);
            ctx.fillStyle = pGrad;
            ctx.fillRect(0, py, w, curH);

            // Organic wood grain fibers along each plank (pure sine-modulated scanlines)
            const phase = plankIdx * 1.9;
            for (let ly = 1; ly < curH - 1; ly += 2) {
                const y = py + ly;
                const wave = Math.sin(ly * 0.23 + phase) * 0.5 + Math.cos(ly * 0.09 - phase) * 0.5;
                if (wave > 0.05) {
                    ctx.fillStyle = `rgba(255, 205, 150, ${(wave * 0.055).toFixed(4)})`;
                } else {
                    ctx.fillStyle = `rgba(22, 9, 2, ${((-wave) * 0.085).toFixed(4)})`;
                }
                ctx.fillRect(0, y, w, 1.3);
            }

            // Subtle longitudinal wood Cathedral streaks across the plank width
            const streakCount = 4;
            for (let s = 0; s < streakCount; s++) {
                const sx = ((plankIdx * 271 + s * 389) % Math.max(200, w));
                const sw = Math.max(140, Math.round(w * 0.28));
                const sy = py + ((plankIdx * 17 + s * 29) % Math.max(8, curH - 6));
                const sGrad = ctx.createRadialGradient(sx, sy, 4, sx, sy, sw);
                sGrad.addColorStop(0, 'rgba(28, 12, 4, 0.10)');
                sGrad.addColorStop(0.6, 'rgba(255, 195, 135, 0.035)');
                sGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
                ctx.fillStyle = sGrad;
                ctx.fillRect(Math.max(0, sx - sw), py, Math.min(w, sw * 2), curH);
            }

            // Occasional vertical plank butt-joint seam
            if (w > 500) {
                const jointX = Math.round(((plankIdx * 37 + 13) % 100) * 0.01 * (w - 240) + 120);
                ctx.fillStyle = 'rgba(18, 7, 2, 0.48)';
                ctx.fillRect(jointX, py, 2, curH);
                ctx.fillStyle = 'rgba(255, 210, 160, 0.08)';
                ctx.fillRect(jointX + 2, py, 1, curH);
            }

            // Beveled horizontal groove between wooden planks
            ctx.fillStyle = 'rgba(15, 6, 1, 0.68)';
            ctx.fillRect(0, py + curH - 2, w, 2);
            ctx.fillStyle = 'rgba(255, 215, 170, 0.11)';
            ctx.fillRect(0, py, w, 1);

            plankIdx++;
        }

        // Warm overhead tabletop lamp sheen + soft edge vignette
        const sheen = ctx.createRadialGradient(w * 0.5, h * 0.42, Math.min(w, h) * 0.08, w * 0.5, h * 0.48, Math.max(w, h) * 0.82);
        sheen.addColorStop(0, 'rgba(255, 220, 175, 0.09)');
        sheen.addColorStop(0.55, 'rgba(0, 0, 0, 0)');
        sheen.addColorStop(1, 'rgba(10, 4, 1, 0.48)');
        ctx.fillStyle = sheen;
        ctx.fillRect(0, 0, w, h);

        this.matPatternCanvas = offCanvas;
    }

    drawBoard(targetCtx = this.ctx) {
        const frameX = this.boardX - 5;
        const frameY = this.boardY - 5;
        const frameW = this.boardWidth + 10;
        const frameH = this.boardHeight + 10;

        targetCtx.save();
        // Subtle recessed tabletop shadow inside the puzzle frame so the wooden grain stays visible!
        targetCtx.fillStyle = 'rgba(16, 7, 2, 0.28)';
        drawRoundedRect(targetCtx, this.boardX, this.boardY, this.boardWidth, this.boardHeight, 2);
        targetCtx.fill();

        // Warm inlaid outer & inner frame lines on the wooden tabletop
        targetCtx.strokeStyle = 'rgba(20, 8, 2, 0.65)';
        targetCtx.lineWidth = 2.5;
        drawRoundedRect(targetCtx, frameX - 1, frameY - 1, frameW + 2, frameH + 2, 4);
        targetCtx.stroke();

        targetCtx.strokeStyle = 'rgba(245, 218, 180, 0.55)';
        targetCtx.lineWidth = 1.6;
        drawRoundedRect(targetCtx, frameX, frameY, frameW, frameH, 3);
        targetCtx.stroke();
        targetCtx.restore();

        if (this.showGhost && this.image) {
            targetCtx.save();
            targetCtx.globalAlpha = 0.28;
            targetCtx.drawImage(this.image, this.boardX, this.boardY, this.boardWidth, this.boardHeight);
            targetCtx.restore();
        }
    }

    /**
     * Draws a pre-stamped piece canvas (punched out via globalCompositeOperation = 'source-in'
     * using the Flood-Fill Alpha Mask — zero Bézier curves, ZERO runtime shadowBlur!).
     */
    drawPiece(piece, customX = null, customY = null, customScale = 1.0) {
        if (!piece || !piece.placedCanvas || !piece.looseCanvas) return;

        const posX = customX !== null ? customX : piece.currentX;
        const posY = customY !== null ? customY : piece.currentY;

        if (piece.isPlaced && customX === null && piece.rotation === 0 && customScale === 1.0) {
            this.ctx.drawImage(piece.placedCanvas, posX, posY, piece.width, piece.height);
            return;
        }

        const padCss = piece.loosePadCss || 0;

        // Ultra-fast direct GPU blit when unrotated (no save/translate/scale/restore, zero shadowBlur!)
        if (piece.rotation === 0) {
            const scaledPad = padCss * customScale;
            this.ctx.drawImage(
                piece.looseCanvas,
                posX - scaledPad,
                posY - scaledPad,
                (piece.width + padCss * 2) * customScale,
                (piece.height + padCss * 2) * customScale
            );
            return;
        }

        const centerX = posX + (piece.width * customScale) / 2;
        const centerY = posY + (piece.height * customScale) / 2;

        this.ctx.save();
        this.ctx.translate(centerX, centerY);
        this.ctx.rotate((piece.rotation * Math.PI) / 180);
        if (customScale !== 1.0) {
            this.ctx.scale(customScale, customScale);
        }
        this.ctx.drawImage(
            piece.looseCanvas,
            -piece.width / 2 - padCss,
            -piece.height / 2 - padCss,
            piece.width + padCss * 2,
            piece.height + padCss * 2
        );
        this.ctx.restore();
    }

    ensureTrayCaches() {
        const dpr = this.dpr || 1;
        const th = Math.max(1, Math.round(this.trayHeight));
        const tw = Math.max(1, Math.round(this.width));
        const key = `${tw}x${th}@${dpr}`;

        const metrics = this.getTrayMetrics();
        this.trayLeftBtn = metrics.leftBtn;
        this.trayRightBtn = metrics.rightBtn;

        if (this._trayCacheKey === key && this.trayBgCanvas && this.trayOverlayCanvas) {
            return metrics;
        }

        const pxW = Math.max(1, Math.floor(tw * dpr));
        const pxH = Math.max(1, Math.floor(th * dpr));

        if (!this.trayBgCanvas) this.trayBgCanvas = document.createElement('canvas');
        this.trayBgCanvas.width = pxW;
        this.trayBgCanvas.height = pxH;
        const bctx = this.trayBgCanvas.getContext('2d', { alpha: false });
        bctx.resetTransform();
        bctx.scale(dpr, dpr);

        const trayGrad = bctx.createLinearGradient(0, 0, 0, th);
        trayGrad.addColorStop(0, '#5a1208');
        trayGrad.addColorStop(0.08, '#a62d18');
        trayGrad.addColorStop(0.35, '#c84422');
        trayGrad.addColorStop(0.65, '#b0351a');
        trayGrad.addColorStop(0.92, '#7e1d0f');
        trayGrad.addColorStop(1, '#440b04');
        bctx.fillStyle = trayGrad;
        bctx.fillRect(0, 0, tw, th);

        bctx.fillStyle = 'rgba(255, 200, 160, 0.08)';
        for (let y = 5; y < th - 5; y += 4) {
            bctx.fillRect(0, y, tw, 1);
        }
        bctx.fillStyle = 'rgba(40, 5, 2, 0.15)';
        for (let y = 7; y < th - 5; y += 4) {
            bctx.fillRect(0, y, tw, 1);
        }

        const { bolsterW, arcSagitta, leftBtn, rightBtn, piecesAreaX, piecesAreaRight, piecesAreaW } = metrics;
        const halfH = th / 2;
        const midY = halfH;
        const arcR = (halfH * halfH + arcSagitta * arcSagitta) / (2 * arcSagitta);
        const arcAngle = Math.asin(Math.min(1, halfH / arcR));
        const leftArcCenterX = bolsterW - arcR + arcSagitta;
        const rightArcCenterX = piecesAreaRight + arcR - arcSagitta;

        // Recessed shading inside center selection channel on trayBgCanvas
        bctx.save();
        bctx.beginPath();
        bctx.arc(leftArcCenterX, midY, arcR, -arcAngle, arcAngle, false);
        bctx.lineTo(piecesAreaRight, th);
        bctx.arc(rightArcCenterX, midY, arcR, Math.PI - arcAngle, Math.PI + arcAngle, false);
        bctx.closePath();
        bctx.clip();

        const recessGrad = bctx.createLinearGradient(0, 0, 0, th);
        recessGrad.addColorStop(0, 'rgba(20, 3, 1, 0.28)');
        recessGrad.addColorStop(0.14, 'rgba(0, 0, 0, 0.04)');
        recessGrad.addColorStop(0.86, 'rgba(0, 0, 0, 0.04)');
        recessGrad.addColorStop(1, 'rgba(20, 3, 1, 0.26)');
        bctx.fillStyle = recessGrad;
        bctx.fillRect(piecesAreaX - 2, 0, piecesAreaW + 4, th);
        bctx.restore();

        // Build trayOverlayCanvas: opaque curved left & right bolsters + lip cast shadows + rim bevel + buttons
        if (!this.trayOverlayCanvas) this.trayOverlayCanvas = document.createElement('canvas');
        this.trayOverlayCanvas.width = pxW;
        this.trayOverlayCanvas.height = pxH;
        const octx = this.trayOverlayCanvas.getContext('2d');
        octx.resetTransform();
        octx.scale(dpr, dpr);
        octx.clearRect(0, 0, tw, th);

        // Opaque left & right mahogany bolster caps (naturally mask pieces sliding under the curved lips!)
        octx.save();
        octx.beginPath();
        octx.moveTo(0, 0);
        octx.lineTo(bolsterW, 0);
        octx.arc(leftArcCenterX, midY, arcR, -arcAngle, arcAngle, false);
        octx.lineTo(0, th);
        octx.closePath();

        octx.moveTo(tw, 0);
        octx.lineTo(tw, th);
        octx.lineTo(piecesAreaRight, th);
        octx.arc(rightArcCenterX, midY, arcR, Math.PI - arcAngle, Math.PI + arcAngle, false);
        octx.closePath();
        octx.clip();
        octx.drawImage(this.trayBgCanvas, 0, 0, tw, th);
        octx.restore();

        // Lip cast shadow onto channel interior
        octx.save();
        octx.beginPath();
        octx.arc(leftArcCenterX, midY, arcR, -arcAngle, arcAngle, false);
        octx.lineTo(piecesAreaRight, th);
        octx.arc(rightArcCenterX, midY, arcR, Math.PI - arcAngle, Math.PI + arcAngle, false);
        octx.closePath();
        octx.clip();

        octx.strokeStyle = 'rgba(15, 2, 0, 0.42)';
        octx.lineWidth = 6;
        octx.beginPath();
        octx.arc(leftArcCenterX + 2.5, midY, arcR, -arcAngle, arcAngle, false);
        octx.stroke();
        octx.beginPath();
        octx.arc(rightArcCenterX - 2.5, midY, arcR, Math.PI - arcAngle, Math.PI + arcAngle, false);
        octx.stroke();
        octx.restore();

        // Top wooden rim bevel across full tray width
        octx.fillStyle = 'rgba(255, 230, 200, 0.42)';
        octx.fillRect(0, 0, tw, 1.5);
        octx.fillStyle = 'rgba(0, 0, 0, 0.55)';
        octx.fillRect(0, 1.5, tw, 1.5);

        // Curved dark mahogany groove + warm bevel highlight on left & right bolster dividers
        octx.strokeStyle = 'rgba(28, 4, 1, 0.85)';
        octx.lineWidth = 2.5;
        octx.beginPath();
        octx.arc(leftArcCenterX, midY, arcR, -arcAngle, arcAngle, false);
        octx.stroke();
        octx.beginPath();
        octx.arc(rightArcCenterX, midY, arcR, Math.PI - arcAngle, Math.PI + arcAngle, false);
        octx.stroke();

        octx.strokeStyle = 'rgba(255, 195, 150, 0.28)';
        octx.lineWidth = 1.2;
        octx.beginPath();
        octx.arc(leftArcCenterX - 1.8, midY, arcR, -arcAngle, arcAngle, false);
        octx.stroke();
        octx.beginPath();
        octx.arc(rightArcCenterX + 1.8, midY, arcR, Math.PI - arcAngle, Math.PI + arcAngle, false);
        octx.stroke();

        // Pre-render compact square orange buttons into local overlay coordinates (y relative to trayY)
        this.drawWoodSquareButton(leftBtn.x, leftBtn.y - this.trayY, leftBtn.w, leftBtn.h, 'hint', octx);
        this.drawWoodSquareButton(rightBtn.x, rightBtn.y - this.trayY, rightBtn.w, rightBtn.h, 'menu', octx);

        this._trayCacheKey = key;
        return metrics;
    }

    drawTray() {
        const metrics = this.ensureTrayCaches();
        const { arcSagitta, piecesAreaX, piecesAreaRight, piecesAreaW } = metrics;

        // 1. Blit pre-rendered mahogany tray background + woodgrain + recessed channel
        this.ctx.drawImage(this.trayBgCanvas, 0, this.trayY, this.width, this.trayHeight);

        // 2. Draw ONLY the ~10-12 visible pieces inside the tray channel (early break on sorted trayX!)
        const minVisX = piecesAreaX - 40;
        const maxVisX = piecesAreaRight + 40;
        const filterEdges = this.filterEdgesOnly;

        this.ctx.save();
        this.ctx.beginPath();
        this.ctx.rect(piecesAreaX - 12, this.trayY, piecesAreaW + 24, this.trayHeight);
        this.ctx.clip();

        for (let i = 0; i < this.trayPieces.length; i++) {
            const p = this.trayPieces[i];
            const thumbScale = p.thumbScale || 0.75;
            const drawX = piecesAreaX + p.trayX + this.trayScrollX;
            if (drawX > maxVisX) break;
            const pw = p.width * thumbScale;
            if (drawX + pw < minVisX) continue;

            if (filterEdges) {
                this.ctx.globalAlpha = p.isBorder ? 1.0 : 0.15;
            }
            this.drawPiece(p, drawX, p.trayY, thumbScale);
        }
        this.ctx.restore();

        // 3. Blit pre-rendered curved bolster caps + lip shadows + Tipp/Menü buttons on top!
        this.ctx.drawImage(this.trayOverlayCanvas, 0, this.trayY, this.width, this.trayHeight);

        // 4. Lightweight scroll thumb indicator
        if (this.maxTrayScrollX > 0) {
            const trackX = piecesAreaX + arcSagitta + 6;
            const trackW = Math.max(40, piecesAreaW - (arcSagitta + 6) * 2);
            const viewRatio = Math.min(1.0, piecesAreaW / (this.maxTrayScrollX + piecesAreaW));
            const thumbW = Math.max(32, trackW * viewRatio);
            const scrollRatio = Math.max(0, Math.min(1, (-this.trayScrollX) / this.maxTrayScrollX));
            const thumbX = trackX + scrollRatio * (trackW - thumbW);
            const indicatorY = this.trayY + this.trayHeight - 3.5;

            this.ctx.fillStyle = 'rgba(255, 255, 255, 0.28)';
            drawRoundedRect(this.ctx, thumbX, indicatorY, thumbW, 2, 1);
            this.ctx.fill();
        }
    }

    drawWoodSquareButton(x, y, w, h, type, targetCtx = this.ctx) {
        const radius = Math.max(6, Math.round(w * 0.13));

        targetCtx.save();
        targetCtx.shadowColor = 'rgba(0, 0, 0, 0.50)';
        targetCtx.shadowBlur = 6;
        targetCtx.shadowOffsetX = 1.5;
        targetCtx.shadowOffsetY = 2.5;

        const btnGrad = targetCtx.createLinearGradient(x, y, x, y + h);
        btnGrad.addColorStop(0, '#f58c2e');
        btnGrad.addColorStop(0.5, '#dc6616');
        btnGrad.addColorStop(1, '#aa4608');
        targetCtx.fillStyle = btnGrad;
        drawRoundedRect(targetCtx, x, y, w, h, radius);
        targetCtx.fill();
        targetCtx.restore();

        targetCtx.save();
        targetCtx.strokeStyle = 'rgba(255, 235, 205, 0.42)';
        targetCtx.lineWidth = 1.4;
        drawRoundedRect(targetCtx, x + 1.5, y + 1.5, w - 3, h - 3, Math.max(4, radius - 1.5));
        targetCtx.stroke();

        targetCtx.strokeStyle = 'rgba(65, 18, 0, 0.62)';
        targetCtx.lineWidth = 1.5;
        drawRoundedRect(targetCtx, x, y, w, h, radius);
        targetCtx.stroke();

        const cx = x + w / 2;
        const cy = y + h / 2;

        if (type === 'hint') {
            const ringR = Math.round(w * 0.31);
            const innerR = Math.round(w * 0.135);

            targetCtx.save();
            targetCtx.shadowColor = 'rgba(60, 15, 0, 0.45)';
            targetCtx.shadowBlur = 3;
            targetCtx.shadowOffsetY = 1.5;
            targetCtx.beginPath();
            targetCtx.arc(cx, cy, ringR, 0, Math.PI * 2);
            targetCtx.arc(cx, cy, innerR, 0, Math.PI * 2, true);
            targetCtx.fillStyle = '#f8f5f0';
            targetCtx.fill('evenodd');
            targetCtx.restore();

            targetCtx.save();
            targetCtx.beginPath();
            targetCtx.arc(cx, cy, ringR, 0, Math.PI * 2);
            targetCtx.arc(cx, cy, innerR, 0, Math.PI * 2, true);
            targetCtx.clip('evenodd');

            targetCtx.strokeStyle = '#d93214';
            targetCtx.lineWidth = Math.max(4, w * 0.115);
            for (let a = 0; a < 4; a++) {
                const angle = (a * Math.PI) / 2 + Math.PI / 4;
                const sx = cx + Math.cos(angle) * (innerR - 3);
                const sy = cy + Math.sin(angle) * (innerR - 3);
                const ex = cx + Math.cos(angle) * (ringR + 3);
                const ey = cy + Math.sin(angle) * (ringR + 3);
                targetCtx.beginPath();
                targetCtx.moveTo(sx, sy);
                targetCtx.lineTo(ex, ey);
                targetCtx.stroke();
            }
            targetCtx.restore();

            targetCtx.strokeStyle = 'rgba(80, 20, 4, 0.72)';
            targetCtx.lineWidth = 1.3;
            targetCtx.beginPath();
            targetCtx.arc(cx, cy, ringR, 0, Math.PI * 2);
            targetCtx.stroke();
            targetCtx.beginPath();
            targetCtx.arc(cx, cy, innerR, 0, Math.PI * 2);
            targetCtx.stroke();

        } else if (type === 'menu') {
            const iconW = w * 0.56;
            const startX = cx - iconW / 2;
            const lineSpacing = h * 0.21;
            const dotR = Math.max(2.3, w * 0.048);
            const barW = Math.max(3.0, w * 0.072);

            for (let i = -1; i <= 1; i++) {
                const ly = cy + i * lineSpacing;

                targetCtx.fillStyle = 'rgba(95, 32, 4, 0.78)';
                targetCtx.beginPath();
                targetCtx.arc(startX + dotR, ly, dotR, 0, Math.PI * 2);
                targetCtx.fill();

                targetCtx.strokeStyle = 'rgba(95, 32, 4, 0.78)';
                targetCtx.lineWidth = barW;
                targetCtx.lineCap = 'round';
                targetCtx.beginPath();
                targetCtx.moveTo(startX + dotR * 3.1, ly);
                targetCtx.lineTo(startX + iconW, ly);
                targetCtx.stroke();

                targetCtx.fillStyle = 'rgba(255, 225, 185, 0.55)';
                targetCtx.beginPath();
                targetCtx.arc(startX + dotR, ly + 1, dotR * 0.75, 0, Math.PI * 2);
                targetCtx.fill();

                targetCtx.strokeStyle = 'rgba(255, 225, 185, 0.45)';
                targetCtx.lineWidth = 1.2;
                targetCtx.beginPath();
                targetCtx.moveTo(startX + dotR * 3.1, ly + barW * 0.48);
                targetCtx.lineTo(startX + iconW, ly + barW * 0.48);
                targetCtx.stroke();
            }
        }

        targetCtx.restore();
    }
}

window.JigsawGame = JigsawGame;
