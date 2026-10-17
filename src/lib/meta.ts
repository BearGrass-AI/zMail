// Labels and icons for buckets, categories and section presets, shared across views.

import {
  Archive,
  BellRing,
  Briefcase,
  CreditCard,
  Eye,
  GraduationCap,
  Hand,
  Heart,
  House,
  KeyRound,
  Mail,
  Megaphone,
  MessagesSquare,
  Newspaper,
  Plane,
  Receipt,
  ShoppingBag,
  Stethoscope,
  Trophy,
  User,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { Bucket, Category } from "@/lib/types";
import type { SectionIcon } from "@/lib/sections";

export const BUCKET_META: Record<Bucket, { label: string; icon: LucideIcon; blurb: string }> = {
  needs_you: { label: "Needs you", icon: Hand, blurb: "People and processes waiting on you" },
  worth_skim: { label: "Worth a skim", icon: Eye, blurb: "Read when you have a minute" },
  ready_archive: { label: "Can go", icon: Archive, blurb: "Safe to clear without reading" },
};

export const CATEGORY_META: Record<Category, { label: string; icon: LucideIcon }> = {
  primary: { label: "Primary", icon: User },
  transactions: { label: "Transactions", icon: Receipt },
  updates: { label: "Updates", icon: BellRing },
  promotions: { label: "Promotions", icon: Megaphone },
  social: { label: "Social", icon: MessagesSquare },
  newsletters: { label: "Newsletters", icon: Newspaper },
  security: { label: "Sign-ins & security", icon: KeyRound },
};

const UNKNOWN_CATEGORY = { label: "Other", icon: Mail };

/** A kind's label and icon; one zMail doesn't know (bad saved state, an odd model answer) gets a plain tile instead of breaking the view. */
export function categoryMeta(c: string): { label: string; icon: LucideIcon } {
  return Object.hasOwn(CATEGORY_META, c) ? CATEGORY_META[c as Category] : UNKNOWN_CATEGORY;
}

export const SECTION_ICON: Record<SectionIcon, LucideIcon> = {
  "credit-card": CreditCard,
  school: GraduationCap,
  home: House,
  plane: Plane,
  heart: Heart,
  briefcase: Briefcase,
  users: Users,
  trophy: Trophy,
  stethoscope: Stethoscope,
  shopping: ShoppingBag,
};
