
export interface Player {
  name: string;
  score: number;
  sets: number;
}

export type GameStatus = 'setup' | 'playing' | 'finished';

export interface MatchHistory {
  player1Sets: number;
  player2Sets: number;
  sets: { p1: number; p2: number }[];
}
