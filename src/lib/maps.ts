// Driving times from Apple Maps (macOS MapKit, via the travel_eta command).
import { invoke } from "@tauri-apps/api/core";

export interface TravelPlace { name: string; address?: string | null }
export interface TravelEta { from: TravelPlace; to: TravelPlace; seconds: number; meters: number }

export function travelEta(from: string, to: string, departMs?: number): Promise<TravelEta> {
  return invoke<TravelEta>("travel_eta", { from, to, departMs: departMs ?? null });
}
