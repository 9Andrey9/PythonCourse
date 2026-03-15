
const models = ['openai', 'mistral', 'claude', 'gemini', 'qwen', 'p1'];
const testImage = "https://www.google.com/images/branding/googlelogo/1x/googlelogo_color_272x92dp.png";

async function checkModels() {
    console.log("Checking Pollinations Vision models...");
    for (const model of models) {
        try {
            console.log(`Testing model: ${model}`);
            const resp = await fetch("https://text.pollinations.ai/", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    messages: [
                        { role: "user", content: [
                            { type: "text", text: "What is in this image? answer in 1 word" },
                            { type: "image_url", image_url: { url: testImage } }
                        ]}
                    ],
                    model: model
                })
            });
            if (resp.ok) {
                const text = await resp.text();
                console.log(`✅ Model ${model} is UP and responded: ${text.trim().substring(0, 50)}...`);
            } else {
                const errText = await resp.text();
                console.log(`❌ Model ${model} returned error: ${resp.status} - ${errText}`);
            }
        } catch (e) {
            console.log(`❌ Model ${model} failed: ${e.message}`);
        }
    }
}

checkModels();
