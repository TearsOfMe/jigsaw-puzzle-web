# Jigsaw Puzzles – Klassisches Holz-Puzzlespiel (Web & iPadOS PWA)

Ein schnelles, klassisches HTML5-Canvas-Puzzlespiel in warmer **Holztisch-Optik**, speziell abgestimmt auf das **iPad (insbesondere iPad 8 Retina `1080 × 810` `@2x`)** sowie Desktop-Browser – komplett ohne externe Frameworks und **100 % offline-fähig** als installierbare Progressive Web App (PWA).

---

## Highlights & Features

1. **Echte Stanzbogen-Silhouetten statt mathematischer Kurven:**
   - **Pixelgenauer Flood-Fill-Scanner (`puzzle_generator.js`):** Extrahiert jedes einzelne Puzzleteil direkt aus echten PNG-Stanzbögen (`assets/silhouettes/`).
   - **Porter-Duff `source-in` Alpha-Stamping:** Keinerlei künstliche Bézier-Kurven – jedes Teil besitzt seine individuelle, organische Stanzform inklusive pixelgenauer Alpha-Treffererkennung beim Antippen und Ziehen.
   - **9 Schwierigkeitsgrade:** `12`, `24`, `48`, `90` (Standard-Stanzbogen), `96`, `150`, `216`, `300` und `400` Teile.

2. **60-FPS Retina-Performance (auch bei 300–400 Teilen):**
   - **Vorgebackene 3D-Kartonkanten & Schlagschatten:** Schatten und Lichtkanten werden einmalig beim Stempeln direkt in das Teil-Canvas (`looseCanvas`) gebacken – kein teures `ctx.shadowBlur` zur Laufzeit.
   - **Statisches Layer-Caching:** Hintergrundbrett (`staticBoardCanvas`), Mahagoni-Leiste (`trayBgCanvas`) und gewölbte Holz-Abschlusskappen (`trayOverlayCanvas`) werden vorgerendert.
   - **`requestAnimationFrame`-Coalescing & `O(1)` Teil-Lookup:** Butterweiches Drag-&-Drop mit Touch- und Maus-Eingabe.

3. **Maßgeschneiderte iPad-Bedienung & Motiv-Galerie:**
   - **Proportionale Mahagoni-Auswahlleiste:** Einheitliche Teilskalierung (`uniformTrayScale`), sodass Nasen und Buchten in der unteren Leiste exakt zu den Brett-Proportionen passen, flankiert von `Tipp`- und `Menü`-Buttons.
   - **18 kuratierte HD-Motive + Eigene Fotos:** Integrierte Galerie mit breiter, touchfreundlicher Scrollleiste (`28 px`) sowie Direkt-Upload eigener Bilder aus der iPad-Fotomediathek.
   - **Automatische Spielstand-Speicherung:** Fortschritt, platzierte Teile und Ablagepositionen auf dem Holztisch werden automatisch in `localStorage` gesichert.
   - **Synthetischer Web-Audio-Sound (`audio.js`):** Dezentes, organisches Einrast- und Klick-Feedback ohne externe Audiodateien.

4. **iPadOS Home-Bildschirm Web-App (PWA) & Offline-Modus:**
   - **Eigene App-Icons (`apple-touch-icon.png`, `152×152` bis `1024×1024`)** im Holz-Design ohne Transparenzränder.
   - **Vollbild-Manifest (`manifest.webmanifest` / `manifest.json`)** ohne Safari-Adressleiste.
   - **Offline-Service-Worker (`sw.js`):** Speichert App-Shell, alle 9 Stanzbögen und sämtliche 18 HD-Motive automatisch im Cache für Spielen im Flugmodus (über HTTPS / GitHub Pages oder `localhost`).

---

## Projektstruktur

```text
jigsaw-puzzle-web/
├── index.html                 # Hauptanwendung, UI-Modals & PWA-Header
├── manifest.json              # Web-App-Manifest
├── manifest.webmanifest       # Standardisiertes PWA-Manifest
├── sw.js                      # Offline-Service-Worker (Cache-First für Assets, Network-First für Code)
├── apple-touch-icon.png       # iPad/iOS Home-Screen Icon (180×180)
├── src/
│   ├── css/style.css          # Layout, Holztisch-UI & Touch-Scrollbar
│   └── js/
│       ├── puzzle_generator.js # Flood-Fill Stanzbogen-Scanner & Alpha-Masken-Stamping
│       ├── game.js             # Spiel-Engine, Retina-Renderer, Touch-Steuerung & Save-State
│       └── audio.js            # Web-Audio-Synthesizer für Klick- & Einrastsounds
└── assets/
    ├── icons/                 # PWA- & Apple-Touch-Icons (32px – 1024px)
    ├── images/                # 18 kuratierte HD-Puzzlemotive
    └── silhouettes/           # 9 PNG-Stanzbögen (12 bis 400 Teile)
```

---

## Lokal starten

Da das Projekt reines Vanilla-HTML/CSS/JS verwendet, reicht jeder beliebige statische Webserver:

```bash
cd jigsaw-puzzle-web
python3 -m http.server 8888
```

Anschließend im Browser öffnen unter `http://localhost:8888`.

---

## Als App auf dem iPad installieren (Vollbild + Offline)

1. Projekt über **GitHub Pages** (`https://tearsofme.github.io/jigsaw-puzzle-web/`) oder im lokalen WLAN in **Safari** auf dem iPad öffnen.
2. Oben rechts auf das **Teilen-Symbol** tippen.
3. **„Zum Home-Bildschirm“** auswählen und mit **„Hinzufügen“** bestätigen.
4. Über das neue **Jigsaw**-Icon auf dem iPad-Home-Bildschirm im Vollbildmodus starten *(über HTTPS / GitHub Pages nach dem ersten Öffnen komplett offline spielbar)*.
