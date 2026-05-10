/**
 * Vanguard Ingester
 * Handles bulk ingestion of files/documentation into specific namespaces.
 */

const fs = require('fs');
const path = require('path');
const memoryClient = require('../memory-client');

class Ingester {
    constructor(tenantId) {
        this.tenantId = tenantId;
    }

    /**
     * Ingest a directory of markdown files into multiple namespaces, with header-based segmenting.
     */
    async ingestDirectory(dirPath, options = {}) {
        if (!fs.existsSync(dirPath)) {
            throw new Error(`Directory not found: ${dirPath}`);
        }

        const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.md'));
        const results = [];
        const targetTenants = options.targetTenants || [this.tenantId];

        console.log(`[vanguard-ingester] Ingesting ${files.length} files from ${dirPath} into ${targetTenants.length} tenants (segmenting enabled)...`);

        for (const file of files) {
            const fullPath = path.join(dirPath, file);
            const content = fs.readFileSync(fullPath, 'utf8');
            
            // Segment the content by headers
            const segments = this._segmentMarkdown(content);
            console.log(`[vanguard-ingester] Split ${file} into ${segments.length} segments.`);

            for (const segment of segments) {
                for (const tId of targetTenants) {
                    const res = await memoryClient.storeMemory(tId, segment, {
                        kind: options.kind || 'document_segment',
                        source: file,
                        metadata: {
                            ingested_at: new Date().toISOString(),
                            path: fullPath,
                            is_segment: true,
                            ...options.metadata
                        }
                    });
                    results.push(res);
                }
            }
        }

        return results;
    }

    /**
     * Split markdown content into segments based on headers.
     */
    _segmentMarkdown(content) {
        const lines = content.split('\n');
        const segments = [];
        let currentSegment = "";

        for (const line of lines) {
            // Split on H1, H2, or H3
            if (line.startsWith('# ') || line.startsWith('## ') || line.startsWith('### ')) {
                if (currentSegment.trim()) {
                    segments.push(currentSegment.trim());
                }
                currentSegment = line + '\n';
            } else {
                currentSegment += line + '\n';
            }
        }

        if (currentSegment.trim()) {
            segments.push(currentSegment.trim());
        }

        // If no headers found, return the whole thing as one segment
        return segments.length > 0 ? segments : [content];
    }

    /**
     * Ingest a single file
     */
    async ingestFile(filePath, options = {}) {
        const content = fs.readFileSync(filePath, 'utf8');
        const fileName = path.basename(filePath);
        
        return memoryClient.storeMemory(this.tenantId, content, {
            kind: options.kind || 'document',
            source: fileName,
            metadata: {
                ingested_at: new Date().toISOString(),
                path: filePath,
                ...options.metadata
            }
        });
    }
}

module.exports = { Ingester };
