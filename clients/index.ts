// Client contract — every client implements this
export interface ClientDefinition {
  id: string;
  name: string;
  description: string;
  colors: { primary: string; accent: string };
}
