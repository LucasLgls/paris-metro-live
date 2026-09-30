import type { ServiceStatus, TrainSnapshot } from "@paris-transit/contracts";

export type StoreListener = () => void;
export type StoreUnsubscribe = () => Promise<void>;

/** Latest train snapshot and service status, shared by the ingestion loop and the HTTP routes. */
export type LiveStore = {
  getSnapshot(): Promise<TrainSnapshot | undefined>;
  /** Stores the next snapshot, assigning its sequence, and notifies subscribers once. */
  setSnapshot(snapshot: Omit<TrainSnapshot, "sequence">): Promise<void>;
  getStatus(): Promise<ServiceStatus | undefined>;
  setStatus(status: ServiceStatus): Promise<void>;
  subscribe(listener: StoreListener): Promise<StoreUnsubscribe>;
  close(): Promise<void>;
};

export class InMemoryLiveStore implements LiveStore {
  private readonly listeners = new Set<StoreListener>();
  private snapshot: TrainSnapshot | undefined;
  private sequence = 0;
  private status: ServiceStatus | undefined;

  getSnapshot(): Promise<TrainSnapshot | undefined> {
    return Promise.resolve(this.snapshot);
  }

  setSnapshot(snapshot: Omit<TrainSnapshot, "sequence">): Promise<void> {
    this.sequence += 1;
    this.snapshot = { ...snapshot, sequence: this.sequence };
    for (const listener of this.listeners) listener();
    return Promise.resolve();
  }

  getStatus(): Promise<ServiceStatus | undefined> {
    return Promise.resolve(this.status);
  }

  setStatus(status: ServiceStatus): Promise<void> {
    this.status = status;
    return Promise.resolve();
  }

  subscribe(listener: StoreListener): Promise<StoreUnsubscribe> {
    this.listeners.add(listener);
    return Promise.resolve(() => {
      this.listeners.delete(listener);
      return Promise.resolve();
    });
  }

  close(): Promise<void> {
    this.listeners.clear();
    return Promise.resolve();
  }
}
