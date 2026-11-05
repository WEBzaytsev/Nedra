import { Disclosure, Flex, Text, useLayoutContext } from "@gravity-ui/uikit";

// Secondary management tasks should not precede the selected folder/group's
// current access on a phone. Keep the approved desktop sections expanded.
export default function ManagementSection({ title, children, heading = true }) {
  const { isMediaActive } = useLayoutContext();
  const body = (
    <Flex direction="column" gap="spacing-3" minWidth="0" paddingBlock="spacing-3">
      {children}
    </Flex>
  );
  return isMediaActive("s") ? (
    <Flex as="section" direction="column" gap="spacing-3" minWidth="0">
      <Text
        as={heading ? "div" : undefined}
        role={heading ? "heading" : undefined}
        aria-level={heading ? 3 : undefined}
        variant={heading ? "subheader-2" : "body-1"}
      >
        {title}
      </Text>
      {children}
    </Flex>
  ) : (
    <Disclosure summary={title}>{body}</Disclosure>
  );
}
