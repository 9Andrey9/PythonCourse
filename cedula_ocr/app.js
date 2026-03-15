    // Configuración de PDF.js para extensiones
    pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("pdf.worker.min.js");

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
            // FASE 0: OCR DE TODOS LOS ARCHIVOS
            const fileDataList = [];
            
            // Inicializar Worker de Tesseract localmente para la extensión
            const worker = await Tesseract.createWorker('spa', 1, {
                workerPath: chrome.runtime.getURL('tesseract-worker.min.js'),
                corePath: chrome.runtime.getURL('tesseract-core.wasm.js'),
                langPath: chrome.runtime.getURL(''), // Carpeta raíz donde está spa.traineddata
                gzip: false // Evitar descompresión extra
            });

            for(let i=0; i < uploadedFiles.length; i++) {
                const file = uploadedFiles[i];
                status.textContent = `Procesando archivo ${i+1}/${uploadedFiles.length}...`;
                
                let img = file.type === 'application/pdf' ? await convertPdfToImage(file) : await processImageFile(file);
                const ocr = await worker.recognize(img);
                fileDataList.push({ name: file.name, text: ocr.data.text, index: i });
            }
            await worker.terminate();

            // FASE 1: DETECTAR CUÁL ES LA CÉDULA (Mejorado: Robusto + Fallback)
            status.textContent = "Identificando Cédula Colombiana...";
            const detectionPrompt = `Analiza estos documentos OCR y dime cuál es la "Cédula de Ciudadanía Colombiana". 
            Busca palabras clave como "REPUBLICA DE COLOMBIA", "CEDULA DE CIUDADANIA", "APELLIDOS", "NOMBRES".
            
            LISTA:
            ${fileDataList.map((f, i) => `[ID: ${i}] Archivo: ${f.name} | Texto: ${f.text.substring(0, 500)}`).join('\n')}
            
            RESPONDE ÚNICAMENTE EL NÚMERO DEL ID (ej: 0). Si tienes dudas, elige el que más se parezca a una identificación.`;
            
            let detectedIDStr = await callAI(detectionPrompt);
            let idIndex = -1;
            
            // Intento 1: Parsing de la IA con Regex
            const match = detectedIDStr.match(/\d+/);
            if (match) idIndex = parseInt(match[0]);

            // Intento 2: Heurística manual (Fallback) si la IA falla o el ID es inválido
            if (idIndex < 0 || idIndex >= fileDataList.length) {
                console.log("IA falló en detectar ID, usando heurística...");
                idIndex = fileDataList.findIndex(f => {
                    const t = f.text.toUpperCase();
                    return t.includes("REPUBLICA") || t.includes("COLOMBIA") || t.includes("CEDULA") || t.includes("NOMBRES");
                });
            }
            
            if (idIndex < 0 || idIndex >= fileDataList.length) {
                throw new Error("No pudimos identificar cuál de los archivos es la Cédula. Asegúrate de que la foto sea clara.");
            }

            const activeIDText = fileDataList[idIndex].text;
            
            // FASE 2: EXTRAER DATOS TITULAR (Reglas de Oro Restituidas)
            status.textContent = "Extrayendo identidad del titular...";
            const idData = await cleanIDData(activeIDText);
            
            // FASE 3: VERIFICAR EL RESTO DE DOCUMENTOS
            const verifications = [];
            for (let i = 0; i < fileDataList.length; i++) {
                if (i === idIndex) continue; // Saltamos la propia cédula
                const file = fileDataList[i];
                status.textContent = `Cruzando datos con ${file.name}...`;
                
                const match = await verifyMatch(idData, file.text, file.name);
                verifications.push(match);
            }

            renderFinalReport(idData, verifications);

        } catch (err) {
            console.error("ANALYSIS_ERROR:", err);
            alert("Error en el análisis: " + (err.message || JSON.stringify(err) || "Ocurrió un error inesperado al procesar los archivos."));
            location.reload();
        }
    };

    async function cleanIDData(rawText) {
        const prompt = `Analiza este texto OCR de una Cédula Colombiana. 
        OBJETIVO: Extraer datos del TITULAR con precisión absoluta y COMPLETOS.
        
        TEXTO OCR: "${rawText}"
        
        REGLAS DE ORO:
        1. NOMBRES COMPLETOS: Extrae TODOS los nombres de pila del titular (ej: si es "MIYER ANDREY", pon ambos). No omitas ninguno.
        2. APELLIDOS COMPLETOS: Extrae ambos apellidos del titular.
        3. ORDEN: Respeta estrictamente el orden del documento.
        4. LIMPIEZA: Elimina ruidos como letras sueltas (ej: "ANDREY E" -> "ANDREY") y nombres de registradores.
        
        Responde estrictamente en JSON:
        {"nombres": "...", "apellidos": "...", "cedula": "..."}`;
        
        const resp = await callAI(prompt);
        return parseCleanJSON(resp);
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
        const result = parseCleanJSON(resp);
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
                jsonMode: true
            })
        });
        return await aiResp.text();
    }

    function renderFinalReport(idData, verifications) {
        loader.style.display = 'none';
        results.style.display = 'block';
        
        // Mostrar card de la cédula detectada
        const idCard = document.getElementById('idDataCard');
        idCard.style.display = 'block';
        document.getElementById('resFullName').textContent = `${idData.nombres} ${idData.apellidos}`.toUpperCase();
        document.getElementById('resCC').textContent = formatDots(idData.cedula);
        
        const list = document.getElementById('supportResultsList');
        list.innerHTML = `<p class="label" style="margin-top: 20px;">Análisis de Documentos (${verifications.length})</p>`;
        
        let allMatched = verifications.length > 0;
        let doubts = false;

        verifications.forEach(v => {
            if (!v.matched) allMatched = false;
            const resLower = v.reason.toLowerCase();
            if (v.matched && (resLower.includes("duda") || resLower.includes("parcial"))) doubts = true;

            const div = document.createElement('div');
            div.className = 'data-card';
            div.style.borderLeft = v.matched ? '4px solid #10b981' : '4px solid #ef4444';
            div.innerHTML = `
                <p style="font-size: 0.8rem; font-weight: 700; color: ${v.matched ? '#10b981' : '#f87171'}">${v.fileName}</p>
                <p style="font-size: 0.9rem; margin-top: 5px;">${v.reason}</p>
                <p style="font-size: 0.75rem; color: var(--dim); margin-top: 4px;">Encontrado: ${v.dataFound}</p>
            `;
            list.appendChild(div);
        });

        const badge = document.getElementById('verdictBadge');
        badge.style.display = 'block';
        
        if (verifications.length === 0) {
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

    // Nueva función para mejorar la calidad de la imagen antes del OCR
    function applyImageFilters(ctx, canvas) {
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        
        for (let i = 0; i < data.length; i += 4) {
            // Convertir a escala de grises
            const avg = (data[i] + data[i+1] + data[i+2]) / 3;
            
            // Aumentar contraste (umbral simple)
            const contrast = 1.2;
            let val = avg;
            val = ((val / 255 - 0.5) * contrast + 0.5) * 255;
            val = Math.max(0, Math.min(255, val));
            
            data[i] = data[i+1] = data[i+2] = val;
        }
        ctx.putImageData(imageData, 0, 0);
    }

    // Ajustamos la carga de imagen normal para que también pase por filtros
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

    function parseCleanJSON(text) {
        try {
            // Limpiar posibles bloques de código Markdown
            let clean = text.replace(/```json/g, '').replace(/```/g, '').trim();
            const start = clean.indexOf('{');
            const end = clean.lastIndexOf('}');
            if (start === -1) {
                console.error("JSON_NOT_FOUND:", text);
                return {};
            }
            return JSON.parse(clean.substring(start, end + 1));
        } catch (e) { 
            console.error("JSON_PARSE_ERROR:", e, text);
            return {}; 
        }
    }

    function formatDots(num) {
        if (!num) return '—';
        const digits = num.toString().replace(/\D/g, '');
        return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    }
