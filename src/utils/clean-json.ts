/**
 * Utilidades para extraer y limpiar JSON de respuestas de LLM.
 * Los modelos a veces envuelven JSON en backticks o agregan comentarios.
 */

/**
 * Extrae el primer bloque JSON válido de un texto.
 * Soporta bloques markdown ```json ... ``` y texto plano mezclado.
 */
export function extractJson(text: string): string {
  // Intenta extraer bloque markdown
  const blockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (blockMatch) {
    return blockMatch[1].trim();
  }
  // Busca el primer objeto/array JSON en texto libre
  const jsonMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch) {
    return jsonMatch[1].trim();
  }
  return text.trim();
}

/**
 * Elimina comentarios de estilo JavaScript (// y /*) del texto.
 */
export function stripComments(text: string): string {
  return text
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Limpia y parsea un string a objeto JSON.
 * Lanza error descriptivo si falla.
 */
export function cleanJson<T = unknown>(text: string): T {
  const cleaned = stripComments(extractJson(text));
  try {
    return JSON.parse(cleaned) as T;
  } catch (e) {
    const err = new Error(
      `cleanJson: no se pudo parsear JSON. Razón: ${(e as Error).message}. Texto limpio: ${cleaned.slice(0, 500)}`
    );
    throw err;
  }
}
