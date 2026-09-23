export interface User {
  id: string;
  username: string;
  totpEnabled: boolean;
}

export type App = { Bindings: Env; Variables: { user: User; sessionId: string } };
