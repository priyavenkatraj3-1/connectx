interface AvatarProps {
  name: string;
  size?: "sm" | "md" | "lg";
  imageUrl?: string;
}

const SIZE_CLASSES = {
  sm: "h-8 w-8 text-xs",
  md: "h-11 w-11 text-sm",
  lg: "h-16 w-16 text-lg",
};

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const initials = parts.slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "");
  return initials.join("") || "?";
}

export function Avatar({ name, size = "md", imageUrl }: AvatarProps) {
  if (imageUrl) {
    return (
      <img
        src={imageUrl}
        alt={name}
        className={`${SIZE_CLASSES[size]} rounded-full object-cover`}
      />
    );
  }

  return (
    <div
      className={`${SIZE_CLASSES[size]} flex items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-accent-500 font-semibold text-white`}
      aria-hidden="true"
    >
      {getInitials(name)}
    </div>
  );
}
