import axios, { AxiosInstance, AxiosError } from "axios";

interface FilterItem {
  field: string;
  value: string | string[] | number | number[];
  operator: string;
}

interface SortItem {
  field: string;
  sort: "asc" | "desc" | null;
}

interface DatatableRequest {
  paginationModel: {
    page: number;
    pageSize: number;
  };
  filterModel: {
    items: FilterItem[];
    logicOperator: string;
    quickFilterValues?: string[];
  };
  sortModel: SortItem[];
}

export class BrunasApiClient {
  private authClient: AxiosInstance;
  private apiClient: AxiosInstance;
  private jwt: string | null = null;

  constructor(
    private email: string,
    private password: string,
    private clientBaseUrl: string
  ) {
    this.authClient = axios.create({
      baseURL: "https://auth.brunas.lt",
      headers: { "Content-Type": "application/json" },
    });

    this.apiClient = axios.create({
      baseURL: clientBaseUrl,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });

    // Interceptor: attach JWT as cookie to every API request
    this.apiClient.interceptors.request.use((config) => {
      if (this.jwt) {
        config.headers.Cookie = `jwt=${this.jwt}`;
      }
      return config;
    });

    // Interceptor: auto re-login on 401
    this.apiClient.interceptors.response.use(
      (response) => response,
      async (error: AxiosError) => {
        const original = error.config;
        if (
          error.response?.status === 401 &&
          original &&
          !(original as unknown as Record<string, unknown>).__isRetry
        ) {
          (original as unknown as Record<string, unknown>).__isRetry = true;
          await this.login();
          original.headers.Cookie = `jwt=${this.jwt}`;
          return this.apiClient(original);
        }
        throw error;
      }
    );
  }

  /**
   * Login and store JWT + refresh token
   */
  async login(): Promise<void> {
    const response = await this.authClient.post("/auth/login", {
      email: this.email,
      password: this.password,
      remember: false,
      login_type: "email_password",
    });

    this.jwt = response.data.data.jwt;
  }

  /**
   * Ensure authenticated before making API calls
   */
  async ensureAuth(): Promise<void> {
    if (!this.jwt) {
      await this.login();
    }
  }

  /**
   * Build a datatable request body
   */
  private buildDatatableRequest(
    filters: FilterItem[] = [],
    page = 0,
    pageSize = 25,
    sort?: SortItem[],
    quickFilter?: string[]
  ): DatatableRequest {
    return {
      paginationModel: { page, pageSize },
      filterModel: {
        items: filters,
        logicOperator: "and",
        ...(quickFilter ? { quickFilterValues: quickFilter } : {}),
      },
      sortModel: sort ?? [],
    };
  }

  // ─── Carriages ──────────────────────────────────────────────

  async findCarriages(
    filters: FilterItem[] = [],
    page = 0,
    pageSize = 25,
    sort?: SortItem[],
    quickFilter?: string[]
  ): Promise<unknown> {
    await this.ensureAuth();
    const body = this.buildDatatableRequest(filters, page, pageSize, sort, quickFilter);
    const response = await this.apiClient.post(
      "/api/v3/aggregated-carriages/datatable/list",
      body
    );
    return response.data;
  }

  async countCarriages(
    filters: FilterItem[] = [],
    quickFilter?: string[]
  ): Promise<unknown> {
    await this.ensureAuth();
    const body = this.buildDatatableRequest(filters, 0, 1, undefined, quickFilter);
    const response = await this.apiClient.post(
      "/api/v3/aggregated-carriages/datatable/count",
      body
    );
    return response.data;
  }

  async getCarriage(id: string): Promise<unknown> {
    await this.ensureAuth();
    const response = await this.apiClient.get(`/api/v3/carriage/${encodeURIComponent(id)}/form`);
    return response.data;
  }

  // ─── Drivers ────────────────────────────────────────────────

  async findDrivers(
    filters: FilterItem[] = [],
    page = 0,
    pageSize = 25,
    sort?: SortItem[],
    quickFilter?: string[]
  ): Promise<unknown> {
    await this.ensureAuth();
    const body = this.buildDatatableRequest(filters, page, pageSize, sort, quickFilter);
    const response = await this.apiClient.post(
      "/api/v3/drivers/datatable/list",
      body
    );
    return response.data;
  }

  async getDriver(id: string): Promise<unknown> {
    await this.ensureAuth();
    const response = await this.apiClient.get(`/api/v3/drivers/${encodeURIComponent(id)}/form`);
    return response.data;
  }

  // ─── Vehicles ───────────────────────────────────────────────

  async findVehicles(
    filters: FilterItem[] = [],
    page = 0,
    pageSize = 25,
    sort?: SortItem[],
    quickFilter?: string[]
  ): Promise<unknown> {
    await this.ensureAuth();
    const body = this.buildDatatableRequest(filters, page, pageSize, sort, quickFilter);
    const response = await this.apiClient.post(
      "/api/v3/vehicles/datatable/list",
      body
    );
    return response.data;
  }

  async getVehicle(id: string): Promise<unknown> {
    await this.ensureAuth();
    const response = await this.apiClient.get(`/api/v3/vehicles/${encodeURIComponent(id)}/form`);
    return response.data;
  }
}
