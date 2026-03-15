
    // Soporte Híbrido: Web Estándar + Extensión de Chrome
    const getAssetPath = (file) => {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
            try {
                return chrome.runtime.getURL(file);
            } catch (e) {}
        }
        // Modo Web (GitHub Pages): Construir ruta absoluta basada en la URL actual
        const baseUrl = window.location.href.split(/[?#]/)[0];
        const baseDir = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
        return baseDir + file;
    };

    // Configuración de PDF.js
    pdfjsLib.GlobalWorkerOptions.workerSrc = getAssetPath("pdf.worker.min.js");

    const idFile = document.getElementById('idFile');
    const extractBtn = document.getElementById('extractBtn');
    const loader = document.getElementById('loader');
    const status = document.getElementById('status');
    const results = document.getElementById('results');
    const mainUI = document.getElementById('mainUI');
    const reloadBtn = document.getElementById('reloadBtn');
    
    let uploadedFiles = [];

    idFile.onchange = (e) => {
        uploadedFiles = Array.from(e.target.files);
        if (uploadedFiles.length > 0) {
            const fileNameDisplay = document.getElementById('fileNameDisplay');
            if (fileNameDisplay) fileNameDisplay.textContent = `✅ ${uploadedFiles.length} archivos cargados`;
            extractBtn.style.display = 'block';
        }
    };

    if (reloadBtn) {
        reloadBtn.onclick = () => location.reload();
    }

    extractBtn.onclick = async () => {
        if (uploadedFiles.length === 0) return;
        mainUI.style.display = 'none';
        loader.style.display = 'block';
        
        try {
            status.textContent = "Preparando motor OCR v5...";
            
            // FASE 0: OCR DE TODOS LOS ARCHIVOS
            const fileDataList = [];
            
            // Tesseract v5+: La configuración más robusta para MV3
            // Usamos la firma explícita (langs, oem, options) para asegurar que tome los paths locales
            const worker = await Tesseract.createWorker('spa', 1, {
                workerPath: getAssetPath('tesseract-worker.min.js'),
                corePath: getAssetPath('tesseract-core.wasm.js'),
                langPath: getAssetPath('').replace(/\/$/, ''), // Carpeta raíz donde está spa.traineddata
                workerBlobURL: false,
                gzip: false,
                logger: m => {
                    if (m.status === 'recognizing text') {
                        status.textContent = `Analizando... ${(m.progress * 100).toFixed(0)}%`;
                    }
                }
            });

            // En v5 con la firma anterior, ya está cargado e inicializado para 'spa'
            // pero por seguridad llamamos a setParameters si es necesario.
            await worker.setParameters({
                tessjs_create_pdf: '0',
                tessjs_create_hocr: '0'
            });

            for(let i=0; i < uploadedFiles.length; i++) {
                const file = uploadedFiles[i];
                status.textContent = `Procesando archivo ${i+1}/${uploadedFiles.length}...`;
                
                let img = file.type === 'application/pdf' ? await convertPdfToImage(file) : await processImageFile(file);
                const ocr = await worker.recognize(img);
                // Truncar texto para no saturar la IA (máx 3000 chars por archivo)
                const truncatedText = ocr.data.text.substring(0, 3000);
                fileDataList.push({ name: file.name, text: truncatedText, index: i });
            }
            await worker.terminate();

            // FASE 1: DETECTAR CUÁL ES LA CÉDULA
            status.textContent = "Identificando Cédula Colombiana...";
            const detectionPrompt = `Analiza estos documentos OCR y dime cuál es la "Cédula de Ciudadanía Colombiana". 
            Busca palabras clave como "REPUBLICA DE COLOMBIA", "CEDULA DE CIUDADANIA", "APELLIDOS", "NOMBRES".
            
            LISTA:
            ${fileDataList.map((f, i) => `[ID: ${i}] Archivo: ${f.name} | Texto: ${f.text.substring(0, 500)}`).join('\n')}
            
            RESPONDE ÚNICAMENTE EL NÚMERO DEL ID (ej: 0). Si tienes dudas, elige el que más se parezca a una identificación.`;
            
            let detectedIDStr = await callAI(detectionPrompt);
            let idIndex = -1;
            
            const match = detectedIDStr.match(/\d+/);
            if (match) idIndex = parseInt(match[0]);

            if (idIndex < 0 || idIndex >= fileDataList.length) {
                // RECHAZO AUTOMÁTICO: No se detectó ninguna cédula
                renderFinalReport({ nombres: "RECHAZADO", apellidos: "CÉDULA NO DETECTADA", cedula: "0" }, [], true);
                return;
            }

            const activeIDText = fileDataList[idIndex].text;
            
            // FASE 2: EXTRAER DATOS TITULAR
            status.textContent = "Extrayendo identidad del titular...";
            const idData = await cleanIDData(activeIDText);
            
            // FASE 3: VERIFICAR EL RESTO DE DOCUMENTOS
            const verifications = [];
            for (let i = 0; i < fileDataList.length; i++) {
                if (i === idIndex) continue;
                const file = fileDataList[i];
                status.textContent = `Cruzando datos con ${file.name}...`;
                
                const matchResult = await verifyMatch(idData, file.text, file.name);
                verifications.push(matchResult);
            }

            renderFinalReport(idData, verifications);

        } catch (err) {
            console.error("ANALYSIS_ERROR:", err);
            alert("Error en el análisis: " + (err.message || "Ocurrió un error inesperado."));
            location.reload();
        }
    };

    async function cleanIDData(rawText) {
        const prompt = `Analiza este texto OCR de una Cédula Colombiana. 
        OBJETIVO: Extraer datos del TITULAR con precisión absoluta y COMPLETOS.
        
        TEXTO OCR: "${rawText}"
        
        REGLAS DE ORO:
        1. NOMBRES COMPLETOS: Extrae TODOS los nombres de pila del titular (ej: si es "MIYER ANDREY", pon ambos). No omitas ninguno.
        2. APELLIDOS COMPLETOS: Extrae ambos apellidos del titular CON ESPACIO ENTRE ELLOS (ej: "PEÑA PEÑA").
        3. ORDEN: Respeta estrictamente el orden del documento.
        4. LIMPIEZA: Elimina ruidos como letras sueltas (ej: "ANDREY E" -> "ANDREY") y nombres de registradores.
        
        Responde estrictamente en JSON:
        {"nombres": "...", "apellidos": "...", "cedula": "..."}`;
        
        const resp = await callAI(prompt);
        const defaults = { nombres: "NO DETECTADO", apellidos: "NO DETECTADO", cedula: "0" };
        return parseCleanJSON(resp, defaults);
    }

    async function verifyMatch(idData, supportText, fileName) {
        const prompt = `ESTUDIA si los datos del titular coinciden con el documento adjunto.
        TITULAR ESTIMADO: ${idData.nombres} ${idData.apellidos}, CC: ${idData.cedula}
        TEXTO DEL DOCUMENTO A VERIFICAR (${fileName}): "${supportText}"
        
        CRITERIOS:
        - Si el nombre/apellido coincide (aunque falte un segundo nombre), marca matched: true pero menciona la duda en reason.
        - Si la cédula coincide, es un match fuerte.
        - Si no hay ninguna coincidencia clara, matched: false.
        
        Responde en JSON:
        {"matched": boolean, "reason": "breve explicación de la decisión", "dataFound": "qué fragmentos de nombre/CC encontraste"}`;
        
        const resp = await callAI(prompt);
        const defaults = { matched: false, reason: "Error al procesar respuesta AI", dataFound: "N/A" };
        const result = parseCleanJSON(resp, defaults);
        result.fileName = fileName;
        return result;
    }

    async function callAI(prompt) {
        const aiResp = await fetch("https://text.pollinations.ai/", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                messages: [{ role: "user", content: prompt }],
                model: "openai",
                extra_args: { json_mode: true }
            })
        });
        return await aiResp.text();
    }

    function renderFinalReport(idData, verifications, autoReject = false) {
        loader.style.display = 'none';
        results.style.display = 'block';
        
        const idCard = document.getElementById('idDataCard');
        idCard.style.display = 'block';
        
        if (autoReject) {
            document.getElementById('resFullName').textContent = "ERROR: IDENTIFICACIÓN NO ENCONTRADA";
            document.getElementById('resFullName').style.color = "#ef4444";
            document.getElementById('resCC').textContent = "Punto de partida no detectado";
        } else {
            document.getElementById('resFullName').textContent = `${idData.nombres} ${idData.apellidos}`.toUpperCase();
            document.getElementById('resFullName').style.color = "var(--text)";
            document.getElementById('resCC').textContent = formatDots(idData.cedula);
        }
        
        const list = document.getElementById('supportResultsList');
        list.innerHTML = `<p class="label" style="margin-top: 20px;">Análisis de Documentos (${verifications.length})</p>`;
        
        let allMatched = verifications.length > 0;
        let doubts = false;

        verifications.forEach(v => {
            if (!v || typeof v !== 'object') return;
            if (v.matched === false) allMatched = false;
            
            const reason = v.reason || "Sin explicación disponible";
            const resLower = reason.toLowerCase();
            if (v.matched && (resLower.includes("duda") || resLower.includes("parcial"))) doubts = true;

            const div = document.createElement('div');
            div.className = 'data-card';
            div.style.borderLeft = v.matched ? '4px solid #10b981' : '4px solid #ef4444';
            div.innerHTML = `
                <p style="font-size: 0.8rem; font-weight: 700; color: ${v.matched ? '#10b981' : '#f87171'}">${v.fileName || 'Archivo'}</p>
                <p style="font-size: 0.9rem; margin-top: 5px;">${reason}</p>
                <p style="font-size: 0.75rem; color: var(--dim); margin-top: 4px;">Encontrado: ${v.dataFound || 'No especificado'}</p>
            `;
            list.appendChild(div);
        });

        const badge = document.getElementById('verdictBadge');
        badge.style.display = 'block';
        
        if (autoReject || verifications.length === 0 && !idData.nombres) {
            badge.textContent = "❌ RECHAZADO";
            badge.style.background = "rgba(239, 68, 68, 0.2)";
            badge.style.color = "#f87171";
            const list = document.getElementById('supportResultsList');
            list.innerHTML = `<p style="text-align:center; color:#f87171; font-weight:bold; margin-top:20px;">
                La verificación requiere una Cédula de Ciudadanía como punto de partida. Por favor, cargue una imagen clara del documento de identidad.
            </p>`;
        } else if (verifications.length === 0) {
            badge.textContent = "ID DETECTADA";
            badge.style.background = "rgba(99, 102, 241, 0.2)";
            badge.style.color = "#818cf8";
        } else if (allMatched && !doubts) {
            badge.textContent = "✅ APROBADO";
            badge.style.background = "rgba(16, 185, 129, 0.2)";
            badge.style.color = "#10b981";
        } else if (!allMatched) {
            badge.textContent = "❌ RECHAZADO";
            badge.style.background = "rgba(239, 68, 68, 0.2)";
            badge.style.color = "#f87171";
        } else {
            badge.textContent = "⚠️ REVISIÓN HUMANA";
            badge.style.background = "rgba(245, 158, 11, 0.2)";
            badge.style.color = "#f59e0b";
        }
    }

    async function convertPdfToImage(file) {
        const buffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 2.5 });
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.height = viewport.height;
        canvas.width = viewport.width;
        await page.render({ canvasContext: ctx, viewport: viewport }).promise;
        applyImageFilters(ctx, canvas);
        return canvas.toDataURL('image/jpeg', 0.95);
    }

    function applyImageFilters(ctx, canvas) {
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        for (let i = 0; i < data.length; i += 4) {
            const avg = (data[i] + data[i+1] + data[i+2]) / 3;
            const contrast = 1.2;
            let val = ((avg / 255 - 0.5) * contrast + 0.5) * 255;
            val = Math.max(0, Math.min(255, val));
            data[i] = data[i+1] = data[i+2] = val;
        }
        ctx.putImageData(imageData, 0, 0);
    }

    async function processImageFile(file) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = async (e) => {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');
                    canvas.width = img.width;
                    canvas.height = img.height;
                    ctx.drawImage(img, 0, 0);
                    applyImageFilters(ctx, canvas);
                    resolve(canvas.toDataURL('image/jpeg', 0.95));
                };
                img.src = e.target.result;
            };
            reader.readAsDataURL(file);
        });
    }

    function parseCleanJSON(text, defaults = {}) {
        try {
            if (!text) return defaults;
            let clean = text.replace(/```json/g, '').replace(/```/g, '').trim();
            const start = clean.indexOf('{');
            const end = clean.lastIndexOf('}');
            if (start === -1) return defaults;
            return { ...defaults, ...JSON.parse(clean.substring(start, end + 1)) };
        } catch (e) { 
            console.error("JSON_PARSE_ERROR:", e);
            return defaults; 
        }
    }

    function formatDots(num) {
        if (!num) return '—';
        const digits = num.toString().replace(/\D/g, '');
        return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    }
