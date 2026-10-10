export interface Player {
  _id: string;
  firstName: string;
  lastName: string;
  username: string;
  avatar: string;
  country: string;
  steamid: string;
  team: string;
  isCoach: boolean;
  /** PrimeCam camera: '' follows the Steam ID, 'none', or 'sender:<id>' */
  camera: string;
  extra: Record<string, string>;
}

export type CreatePlayerDTO = Omit<Player, '_id'>;
export type UpdatePlayerDTO = Partial<CreatePlayerDTO>;