import type { MessageStatus } from "../../types/message";
import { CheckIcon, DoubleCheckIcon } from "../ui/icons";

export function MessageStatusTicks({ status }: { status: MessageStatus }) {
  if (status === "read") {
    return <DoubleCheckIcon width={15} height={15} className="text-sky-300" aria-label="Read" />;
  }
  if (status === "delivered") {
    return <DoubleCheckIcon width={15} height={15} className="text-white/70" aria-label="Delivered" />;
  }
  return <CheckIcon width={15} height={15} className="text-white/70" aria-label="Sent" />;
}
