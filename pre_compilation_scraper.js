/**
 * Nobel Prize & Wikidata Compiler
 * Run this script with Node.js to generate 'nobel_data.js'
 * Command: node scraper.js
 */

const fs = require('fs');

// Controlled Concurrency Helper for Nobel API
async function mapLimit(items, limit, fn) {
    const results = [];
    const executing = new Set();
    let index = 0;

    for (const item of items) {
        const p = Promise.resolve().then(() => fn(item, index++));
        results.push(p);
        executing.add(p);
        const clean = () => executing.delete(p);
        p.then(clean, clean);
        if (executing.size >= limit) {
            await Promise.race(executing);
        }
    }
    return Promise.all(results);
}

// Helper to split an array into chunks
function chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}

/**
 * Fetches images and English Wikipedia URLs for a batch of QIDs at once
 */
async function fetchWikidataDetailsInBatch(qids) {
    if (qids.length === 0) return {};

    const valuesString = qids.map(qid => `wd:${qid}`).join(' ');
    
    // SPARQL query that optionally looks for an image and the English Wikipedia sitelink
    const query = `
        SELECT ?item ?image ?article WHERE {
            VALUES ?item { ${valuesString} }
            OPTIONAL { ?item wdt:P18 ?image . }
            OPTIONAL {
                ?article schema:about ?item ;
                         schema:isPartOf <https://en.wikipedia.org/> .
            }
        }
    `;
    
    const url = `https://query.wikidata.org/sparql?query=${encodeURIComponent(query)}&format=json`;
    console.log(`🌐 Querying Wikidata API URL: ${url}`);

    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'NobelPrizeCompiler/1.0 (https://github.com/stevenjohnston123; contact via GitHub)'
            }
        });

        if (!response.ok) {
            console.error(`⚠️ Wikidata batch failed with status: ${response.status}`);
            return {};
        }

        const data = await response.json();
        const batchMap = {};

        if (data && data.results && data.results.bindings) {
            data.results.bindings.forEach(binding => {
                const qid = binding.item.value.split('/').pop();
                
                // Initialize the record if it doesn't exist yet
                if (!batchMap[qid]) {
                    batchMap[qid] = { imageUrl: null, wikipediaUrl: null };
                }

                if (binding.image) {
                    batchMap[qid].imageUrl = binding.image.value;
                }
                if (binding.article) {
                    batchMap[qid].wikipediaUrl = binding.article.value;
                }
            });
        }
        return batchMap;
    } catch (error) {
        console.error('❌ Error fetching batch data from Wikidata:', error);
        return {};
    }
}

async function run() {
    console.log("🚀 Starting Nobel compilation pipeline...");

    try {
        // Step 1: Fetch all prizes
        console.log("📦 Fetching all Nobel Prizes...");
        const prizesUrl = 'https://api.nobelprize.org/2.1/nobelPrizes?limit=1000&sort=asc';
        console.log(`🌐 Querying Nobel API URL: ${prizesUrl}`);
        
        const prizesRes = await fetch(prizesUrl);
        if (!prizesRes.ok) throw new Error("Failed to fetch prizes list");
        const prizesData = await prizesRes.json();
        const rawPrizes = prizesData.nobelPrizes || [];
        console.log(`✅ Retrieved ${rawPrizes.length} prize records.`);

        // Step 2: Extract unique Laureate IDs
        const laureateIds = new Set();
        rawPrizes.forEach(prize => {
            if (prize.laureates) {
                prize.laureates.forEach(l => {
                    if (l.id) laureateIds.add(l.id);
                });
            }
        });
        const uniqueIds = Array.from(laureateIds);
        console.log(`🔍 Found ${uniqueIds.length} unique Laureate records to resolve.`);

        // Step 3: Fetch details for all Laureates from Nobel API
        const laureateMap = {};
        const qidToLaureateId = {};
        let completed = 0;

        console.log("⏳ Resolving Laureate details from Nobel API (concurrency limit: 5)...");
        await mapLimit(uniqueIds, 5, async (id) => {
            try {
                const laureateUrl = `https://api.nobelprize.org/2.1/laureate/${id}`;
                const aurRes = await fetch(laureateUrl);
                if (!aurRes.ok) throw new Error(`Status ${aurRes.status}`);
                const rawAur = await aurRes.json();
                const laureate = Array.isArray(rawAur) ? rawAur[0] : rawAur;

                let externalLink = "#";
                let qId = null;

                if (laureate.nobelPrizes?.length > 0) {
                    externalLink = laureate.nobelPrizes[0].links?.find(l => l.rel === 'external')?.href || "#";
                }

                if (laureate.wikidata) {
                    qId = laureate.wikidata.id || laureate.wikidata.url?.split('/').pop();
                    if (qId) {
                        qidToLaureateId[qId] = id;
                    }
                }

                laureateMap[id] = {
                    externalLink,
                    imageUrl: null,
                    wikipediaUrl: null // Will be populated by Wikidata
                };
            } catch (err) {
                laureateMap[id] = { externalLink: "#", imageUrl: null, wikipediaUrl: null };
            }

            completed++;
            if (completed % 100 === 0 || completed === uniqueIds.length) {
                console.log(`   [Progress] Resolved ${completed}/${uniqueIds.length} laureates from Nobel API...`);
            }
        });

        // Step 4: Batch resolve images & Wikipedia URLs from Wikidata
        const allQids = Object.keys(qidToLaureateId);
        console.log(`⏳ Batch resolving ${allQids.length} images & Wiki links from Wikidata in chunks of 100...`);
        const qidChunks = chunkArray(allQids, 100);

        for (const chunk of qidChunks) {
            const batchDetailsMap = await fetchWikidataDetailsInBatch(chunk);
            
            // Map the resolved items back to our main laureate dataset
            Object.entries(batchDetailsMap).forEach(([qid, details]) => {
                const laureateId = qidToLaureateId[qid];
                if (laureateId && laureateMap[laureateId]) {
                    laureateMap[laureateId].imageUrl = details.imageUrl;
                    laureateMap[laureateId].wikipediaUrl = details.wikipediaUrl;
                }
            });

            // Brief pause to respect Wikidata thresholds
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        // Step 5: Map compiled profiles back to the prize objects
        console.log("🛠️ Packaging final consolidated data structure...");
        const compiledData = rawPrizes.map(prize => {
            const laureates = (prize.laureates || []).map(laur => {
                const resolved = laureateMap[laur.id] || { externalLink: "#", imageUrl: null, wikipediaUrl: null };
                return {
                    id: laur.id,
                    name: laur.knownName?.en || 'Nobel Laureate',
                    motivation: laur.motivation?.en || 'No description available',
                    externalLink: resolved.externalLink,
                    imageUrl: resolved.imageUrl,
                    wikipediaUrl: resolved.wikipediaUrl
                };
            });

            return {
                awardYear: prize.awardYear,
                category: prize.category?.en,
                categoryFullName: prize.categoryFullName?.en,
                laureates
            };
        });

        // Step 6: Write compiler output to file
        const fileContent = `/** Compiled Nobel Data Bundle */\nwindow.nobelData = ${JSON.stringify(compiledData, null, 2)};\n`;
        fs.writeFileSync('nobel_data.js', fileContent, 'utf-8');
        console.log("🎉 Successfully created 'nobel_data.js'!");

    } catch (err) {
        console.error("❌ Pre-compilation pipeline failed:", err);
    }
}

run();