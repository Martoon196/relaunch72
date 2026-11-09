<?php
/**
 * Uninstall removes only this plugin's own settings, connection key, pairing, locks
 * and activity log. It deliberately keeps every post, attachment, category, and every
 * SEO value (including Yoast SEO / Rank Math fields and the _r72_* provenance meta on
 * managed posts), so removing the plugin never silently deletes published content or
 * SEO data.
 *
 * @package Relaunch72Publisher
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

foreach ( array( 'r72pub_secret', 'r72pub_pairing', 'r72pub_settings', 'r72pub_site_seo', 'r72pub_audit' ) as $option ) {
	delete_option( $option );
}
global $wpdb;
$wpdb->query( $wpdb->prepare( "DELETE FROM {$wpdb->options} WHERE option_name LIKE %s", $wpdb->esc_like( 'r72pub_lock_' ) . '%' ) );
// r72pub_site_id is kept so a reinstall keeps the same site identity and existing
// Relaunch72 article targets remain valid.
