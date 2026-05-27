/**
 * Comando `amon watch` — stub documentado.
 *
 * Estado actual: NO IMPLEMENTADO. Existe como placeholder explícito para
 * fijar el contrato futuro y evitar que SB Runtime u otros consumidores
 * lo invoquen por accidente.
 *
 * Diseño previsto (cuando se implemente):
 *   - Mantiene un proceso en línea que TAILEA outputs/events.jsonl
 *     (fs.watch + read-from-offset) y emite los nuevos eventos por:
 *       a) STDOUT (NDJSON) — modo "tee", consumible por pipes.
 *       b) WebSocket o SSE local en un puerto configurable
 *          (AMON_WATCH_PORT, default 7766) — consumible por SB Runtime.
 *   - Honra AMON_EVENTS_PATH para apuntar a un stream alternativo.
 *   - Reconnect-friendly: si rotamos el archivo, reabre.
 *   - Cierra limpio con SIGINT/SIGTERM, escribiendo command.done.
 *
 * Hasta entonces, SB Runtime debe leer eventos históricos parseando
 * outputs/events.jsonl directamente. El modo Batch CLI ya cubre eso:
 * cada comando termina dejando el stream consistente.
 */
import { warn } from "../utils/logger";

export async function watchCommand(): Promise<number> {
  warn("[amon watch] No implementado todavía.");
  warn("[amon watch] Diseño previsto: tail de outputs/events.jsonl + SSE/WS.");
  warn("[amon watch] Mientras tanto, SB Runtime lee outputs/events.jsonl como histórico.");
  return 2;
}
