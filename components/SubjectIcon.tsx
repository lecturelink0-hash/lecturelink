import {
  Activity,
  Baby,
  Bone,
  Brain,
  Bug,
  Droplet,
  Droplets,
  Ear,
  Eye,
  Fingerprint,
  Flower2,
  Heart,
  Ribbon,
  Scale,
  Scissors,
  Shield,
  Stethoscope,
  Utensils,
  Wind,
  type LucideIcon,
  type LucideProps,
} from 'lucide-react';

export function pickSubjectIcon(name: string): LucideIcon {
  if (/외과/.test(name)) return Scissors;
  if (/순환|심/.test(name)) return Heart;
  if (/호흡|폐/.test(name)) return Wind;
  if (/소화|위장|간담췌/.test(name)) return Utensils;
  if (/비뇨/.test(name)) return Droplets;
  if (/신장|콩팥/.test(name)) return Droplet;
  if (/감염/.test(name)) return Bug;
  if (/내분비/.test(name)) return Activity;
  if (/알레르기|알러지/.test(name)) return Flower2;
  if (/혈액/.test(name)) return Droplets;
  if (/종양|암/.test(name)) return Ribbon;
  if (/류마티스|정형|골/.test(name)) return Bone;
  if (/부인|산과|소아/.test(name)) return Baby;
  if (/정신|신경/.test(name)) return Brain;
  if (/이비인후/.test(name)) return Ear;
  if (/안과/.test(name)) return Eye;
  if (/피부/.test(name)) return Fingerprint;
  if (/예방/.test(name)) return Shield;
  if (/법규|법/.test(name)) return Scale;
  return Stethoscope;
}

export function SubjectIcon({ name, ...props }: LucideProps & { name: string }) {
  const Icon = pickSubjectIcon(name);
  return <Icon {...props} />;
}
