import axios from 'axios';

/**
 * FigmaProxy: Implements the Sema (Semantic Transport) Protocol for Figma.
 * Responsible for fetching Figma canvas data and mapping it to a semantic catalog.
 */

export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  children?: FigmaNode[];
  [key: string]: any;
}

export interface SemanticMapping {
  nodeId: string;
  semanticLabel: string;
  description: string;
}

export class FigmaProxy {
  private apiToken: string;
  private fileKey: string;
  private baseUrl = 'https://api.figma.com/v1';

  constructor(apiToken: string, fileKey: string) {
    this.apiToken = apiToken;
    this.fileKey = fileKey;
  }

  /**
   * Fetches the full document tree from Figma.
   */
  async getDocument(): Promise<FigmaNode> {
    try {
      const response = await axios.get(`${this.baseUrl}/files/${this.fileKey}`, {
        headers: { 'X-Figma-Token': this.apiToken }
      });
      return response.data.document;
    } catch (error) {
      console.error('Error fetching Figma document:', error);
      throw error;
    }
  }

  /**
   * Maps Figma nodes to an internal knowledge catalog based on names/types.
   * This is a placeholder for the Sema Protocol logic.
   */
  async mapToKnowledgeCatalog(nodes: FigmaNode[]): Promise<SemanticMapping[]> {
    const mappings: SemanticMapping[] = [];

    const traverse = (node: FigmaNode) => {
      // Simple heuristic for semantic labels: look for [Sema:Label] in node names
      const match = node.name.match(/\[Sema:(.+)\]/);
      if (match) {
        mappings.push({
          nodeId: node.id,
          semanticLabel: match[1],
          description: `Mapped from Figma node: ${node.name} (${node.type})`
        });
      }

      if (node.children) {
        node.children.forEach(traverse);
      }
    };

    nodes.forEach(traverse);
    return mappings;
  }

  /**
   * Extracts a semantic snapshot of the current canvas state.
   */
  async getSemanticSnapshot(): Promise<any> {
    const doc = await this.getDocument();
    const mappings = await this.mapToKnowledgeCatalog([doc]);
    
    return {
      timestamp: new Date().toISOString(),
      fileKey: this.fileKey,
      mappings: mappings,
      rawSummary: `Found ${mappings.length} semantic mappings in the Figma file.`
    };
  }
}
