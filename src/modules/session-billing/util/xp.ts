/** Price sheet: 25 XP for every 15 minutes played. */
export const XP_PER_BLOCK = 25;
export const XP_BLOCK_SECONDS = 15 * 60;

/**
 * XP earned for the seconds a session was metered (played, not paused),
 * counted by the second like the bill: 15 min -> 25, 1 h -> 100, 7 min -> 11.
 * Free play (a pass window) earns XP too: it's the time played that counts.
 */
export function xpForSeconds(seconds: number): number {
  return Math.max(Math.floor((seconds * XP_PER_BLOCK) / XP_BLOCK_SECONDS), 0);
}
