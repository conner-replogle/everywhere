export interface User {
  id: string;
  username: string;
}

export type App = { Bindings: Env; Variables: { user: User } };
