-- Correction controls need workspace categories before E7 category management.
CREATE FUNCTION public.seed_new_workspace_categories() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO public.categories(workspace_id,name,kind,system_category_code)
    SELECT NEW.id,s.name,s.kind,s.code FROM public.system_categories s
    ON CONFLICT (workspace_id,name) DO NOTHING;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.seed_new_workspace_categories() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER workspace_default_categories AFTER INSERT ON public.workspaces
FOR EACH ROW EXECUTE FUNCTION public.seed_new_workspace_categories();
--> statement-breakpoint
-- Also handle reference data seeded after an existing workspace was created.
CREATE FUNCTION public.seed_new_system_category() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO public.categories(workspace_id,name,kind,system_category_code)
    SELECT w.id,NEW.name,NEW.kind,NEW.code FROM public.workspaces w
    WHERE NOT EXISTS (SELECT 1 FROM public.categories c WHERE c.workspace_id=w.id AND c.system_category_code=NEW.code)
    ON CONFLICT (workspace_id,name) DO NOTHING;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.seed_new_system_category() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER system_category_workspace_defaults AFTER INSERT ON public.system_categories
FOR EACH ROW EXECUTE FUNCTION public.seed_new_system_category();
--> statement-breakpoint
INSERT INTO public.categories(workspace_id,name,kind,system_category_code)
  SELECT w.id,s.name,s.kind,s.code FROM public.workspaces w CROSS JOIN public.system_categories s
  WHERE NOT EXISTS (SELECT 1 FROM public.categories c WHERE c.workspace_id=w.id AND c.system_category_code=s.code)
  ON CONFLICT (workspace_id,name) DO NOTHING;
