import { TooltipProvider } from "@/components/ui/tooltip";

export function App() {
  return (
    <TooltipProvider>
      <div className="flex h-full items-center justify-center">
        <h1 className="text-2xl font-bold text-foreground">
          PPM — Personal Project Manager
        </h1>
      </div>
    </TooltipProvider>
  );
}
