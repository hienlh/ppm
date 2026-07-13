/**
 * Support / donation popup opened from the login footer "Buy me a coffee" link.
 * Shows both options at once: a VietQR bank-transfer QR (Vietnamese supporters)
 * and a Wise international-transfer link — side by side on desktop, stacked on
 * mobile. Adaptive shell — Dialog on desktop, BottomSheet on mobile.
 */
import { useState } from "react";
import { Globe, Heart, QrCode } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-is-mobile";

const WISE_URL = "https://wise.com/pay/me/lehongh";
const VIETQR_IMAGE = "/donate-qr.png";
const VIETQR_ACCOUNT = "LE HONG HIEN";
const VIETQR_BANK = "Techcombank";

function SectionLabel({ children }: { children: string }) {
  return (
    <span className="font-mono text-[11px] font-medium uppercase tracking-wide text-text-subtle">
      {children}
    </span>
  );
}

function SupportBody() {
  const [qrError, setQrError] = useState(false);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col items-center gap-1 text-center">
        <div className="flex size-11 items-center justify-center rounded-xl bg-surface-elevated">
          <Heart className="size-5 text-primary" />
        </div>
        <h2 className="text-lg font-semibold text-foreground">Support PPM</h2>
        <p className="text-sm text-text-secondary">Thanks for keeping this project alive.</p>
      </div>

      <div className="grid gap-5 md:grid-cols-2 md:gap-6">
        {/* Vietnam — bank transfer QR */}
        <section className="flex flex-col items-center gap-3">
          <SectionLabel>Vietnam</SectionLabel>
          {qrError ? (
            <div className="flex size-40 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border text-text-subtle">
              <QrCode className="size-8" />
              <span className="text-xs">QR code coming soon</span>
            </div>
          ) : (
            <img
              src={VIETQR_IMAGE}
              alt="Bank transfer QR code"
              onError={() => setQrError(true)}
              className="size-40 rounded-xl border border-border bg-white object-contain p-2"
            />
          )}
          <div className="text-center">
            <p className="text-sm font-medium text-foreground">{VIETQR_ACCOUNT}</p>
            <p className="text-xs text-text-subtle">{VIETQR_BANK}</p>
          </div>
          <p className="text-center text-xs text-text-secondary">
            Quét mã QR bằng ứng dụng ngân hàng để chuyển khoản.
          </p>
        </section>

        {/* International — Wise transfer */}
        <section className="flex flex-col items-center justify-center gap-3 border-t border-border pt-5 md:border-l md:border-t-0 md:pl-6 md:pt-0">
          <SectionLabel>International</SectionLabel>
          <p className="text-center text-sm text-text-secondary">
            Send an international transfer via Wise — multi-currency, low fees.
          </p>
          <Button asChild className="w-full">
            <a href={WISE_URL} target="_blank" rel="noopener noreferrer">
              <Globe className="size-4" />
              Support via Wise
            </a>
          </Button>
        </section>
      </div>
    </div>
  );
}

interface SupportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SupportDialog({ open, onOpenChange }: SupportDialogProps) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <BottomSheet open={open} onClose={() => onOpenChange(false)} className="popover-solid">
        <div className="px-4 pb-4 pt-1">
          <SupportBody />
        </div>
      </BottomSheet>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogTitle className="sr-only">Support PPM</DialogTitle>
        <SupportBody />
      </DialogContent>
    </Dialog>
  );
}
