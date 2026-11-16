/**
 * Specialty-card tiers and drop weights.
 *
 * A lower rarity number is rarer. Last place receives the lowest number in
 * that drop: Legendary, then Epic, then Rare, then Common. Shield and Turbo
 * share Rare.
 *
 * final_specialty_cards.md does not give numeric weights. SPECIALTY_CARD_DROP_WEIGHTS
 * is the single place to retune how often each card is drawn. Changing it does
 * not change tier order.
 */

export const SPECIALTY_CARD_RARITY = {
  LEGENDARY: 1,
  EPIC: 2,
  RARE: 3,
  COMMON: 4,
} as const;

export const CARDS_ROSTER = [
  { id: "RESPIN", rarity: SPECIALTY_CARD_RARITY.COMMON },
  { id: "SHIELD", rarity: SPECIALTY_CARD_RARITY.RARE },
  { id: "TURBO", rarity: SPECIALTY_CARD_RARITY.RARE },
  { id: "DOUBLE POINTS", rarity: SPECIALTY_CARD_RARITY.EPIC },
  { id: "WILD CARD", rarity: SPECIALTY_CARD_RARITY.LEGENDARY },
] as const;

/**
 * Engineering default from ticket I, 13 slots:
 * Respin 5, Shield 3, Turbo 3, Double Points 1, Wild Card 1.
 */
export const SPECIALTY_CARD_DROP_WEIGHTS = {
  RESPIN: 5,
  SHIELD: 3,
  TURBO: 3,
  "DOUBLE POINTS": 1,
  "WILD CARD": 1,
} as const satisfies Record<(typeof CARDS_ROSTER)[number]["id"], number>;

export function specialtyCardRarity(cardId: string): number {
  const card = CARDS_ROSTER.find((entry) => entry.id === cardId);
  return card ? card.rarity : SPECIALTY_CARD_RARITY.COMMON;
}

/** One pool entry per weight, in roster order. */
export function specialtyCardDropPool(): string[] {
  const pool: string[] = [];
  for (const card of CARDS_ROSTER) {
    const copies = SPECIALTY_CARD_DROP_WEIGHTS[card.id];
    for (let copy = 0; copy < copies; copy++) pool.push(card.id);
  }
  return pool;
}
