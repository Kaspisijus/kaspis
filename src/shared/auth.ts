import axios from "axios";

export interface ClientInfo {
  id: string;
  name: string;
  domain: string;
}

/**
 * Authenticate against Brunas auth API with email/password.
 * Returns the JWT string.
 */
export async function loginWithCredentials(
  email: string,
  password: string,
): Promise<string> {
  const response = await axios.post("https://auth.brunas.lt/auth/login", {
    email,
    password,
    remember: false,
    login_type: "email_password",
  });
  const jwt = response.data?.data?.jwt;
  if (!jwt) throw new Error("No JWT returned from Brunas auth");
  return jwt;
}

/**
 * Resolve which Brunas clients the user has access to,
 * and whether they have super-admin privileges.
 */
export async function resolveClients(
  jwt: string,
): Promise<{ isSuper: boolean; clients: ClientInfo[]; email: string }> {
  const authHttp = axios.create({
    baseURL: "https://savitarna.brunas.lt",
    headers: {
      "Content-Type": "application/json",
      Cookie: `jwt=${jwt}`,
    },
  });

  const accessRes = await authHttp.get("/auth/auth/access");
  const accessData = accessRes.data?.data ?? {};
  const isSuper: boolean = accessData.super === true;
  const email: string = accessData.email ?? "";
  const accessList: Array<{ clientId: string }> = accessData.access ?? [];
  const allowedIds = new Set(accessList.map((a) => a.clientId));

  const clientsRes = await authHttp.get("/auth/clients");
  const allClients: Array<{
    id: string;
    name: string;
    domains?: string[];
  }> = clientsRes.data?.data ?? [];

  const filtered = isSuper
    ? allClients
    : allClients.filter((c) => allowedIds.has(c.id));

  const clients: ClientInfo[] = filtered.map((c) => ({
    id: c.id,
    name: c.name,
    domain: c.domains?.[0] ?? "",
  }));

  return { isSuper, clients, email };
}
